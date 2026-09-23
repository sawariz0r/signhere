#define _GNU_SOURCE
#include <errno.h>
#include <fcntl.h>
#include <limits.h>
#include <linux/audit.h>
#include <linux/filter.h>
#include <linux/landlock.h>
#include <linux/sched.h>
#include <linux/seccomp.h>
#include <stddef.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/prctl.h>
#include <sys/resource.h>
#include <sys/stat.h>
#include <sys/socket.h>
#include <sys/syscall.h>
#include <unistd.h>

/* Debian 12 headers can predate ABI 3; runtime support is still mandatory. */
#ifndef LANDLOCK_ACCESS_FS_TRUNCATE
#define LANDLOCK_ACCESS_FS_TRUNCATE (1ULL << 14)
#endif

/* Linux-only, unprivileged parser boundary. No setuid, capabilities or network.
 * Fail closed if the host cannot enforce Landlock ABI 3 and seccomp filters.
 * Invocation: pdf-sandbox JOB_DIRECTORY ABSOLUTE_EXECUTABLE [ARGUMENT ...]
 * Public runtime paths are image-owned; keys, data, /proc and other jobs are not
 * allowed. This is not a boundary against compromise of the parent application.
 */
#if defined(__x86_64__)
#define EXPECTED_ARCH AUDIT_ARCH_X86_64
#elif defined(__aarch64__)
#define EXPECTED_ARCH AUDIT_ARCH_AARCH64
#else
#error "The sandbox currently supports Linux x86_64 and aarch64 only"
#endif

static void fail(const char *message) {
    fprintf(stderr, "PDF sandbox: %s (%s)\n", message, strerror(errno));
    exit(126);
}

static void limit_resource(int resource, rlim_t limit) {
    const struct rlimit value = {limit, limit};
    if (setrlimit(resource, &value) < 0) fail("cannot enforce resource limit");
}

static void allow_path(int ruleset, const char *path, uint64_t rights, int required) {
    int descriptor = open(path, O_PATH | O_CLOEXEC);
    if (descriptor < 0) {
        if (!required && errno == ENOENT) return;
        fail("cannot open an allowed runtime path");
    }
    struct stat info;
    if (fstat(descriptor, &info) < 0) fail("cannot inspect an allowed runtime path");
    if (!S_ISDIR(info.st_mode)) rights &= LANDLOCK_ACCESS_FS_EXECUTE | LANDLOCK_ACCESS_FS_READ_FILE | LANDLOCK_ACCESS_FS_WRITE_FILE | LANDLOCK_ACCESS_FS_TRUNCATE;
    const struct landlock_path_beneath_attr rule = { .allowed_access = rights, .parent_fd = descriptor };
    if (syscall(SYS_landlock_add_rule, ruleset, LANDLOCK_RULE_PATH_BENEATH, &rule, 0) < 0) fail("cannot enforce allowed runtime path");
    if (close(descriptor) < 0) fail("cannot close runtime path descriptor");
}

static void restrict_filesystem(const char *job) {
    const int abi = (int)syscall(SYS_landlock_create_ruleset, NULL, 0, LANDLOCK_CREATE_RULESET_VERSION);
    if (abi < 3) { errno = ENOTSUP; fail("Landlock ABI 3 or newer is required"); }
    const uint64_t read_only = LANDLOCK_ACCESS_FS_EXECUTE | LANDLOCK_ACCESS_FS_READ_FILE | LANDLOCK_ACCESS_FS_READ_DIR;
    const uint64_t all_rights = read_only | LANDLOCK_ACCESS_FS_WRITE_FILE | LANDLOCK_ACCESS_FS_REMOVE_DIR |
        LANDLOCK_ACCESS_FS_REMOVE_FILE | LANDLOCK_ACCESS_FS_MAKE_CHAR | LANDLOCK_ACCESS_FS_MAKE_DIR |
        LANDLOCK_ACCESS_FS_MAKE_REG | LANDLOCK_ACCESS_FS_MAKE_SOCK | LANDLOCK_ACCESS_FS_MAKE_FIFO |
        LANDLOCK_ACCESS_FS_MAKE_BLOCK | LANDLOCK_ACCESS_FS_MAKE_SYM | LANDLOCK_ACCESS_FS_REFER |
        LANDLOCK_ACCESS_FS_TRUNCATE;
    const struct landlock_ruleset_attr attrs = { .handled_access_fs = all_rights };
    int ruleset = (int)syscall(SYS_landlock_create_ruleset, &attrs, sizeof(attrs), 0);
    if (ruleset < 0) fail("cannot create filesystem rules");
    allow_path(ruleset, "/usr", read_only, 1);
    allow_path(ruleset, "/lib", read_only, 0);
    allow_path(ruleset, "/lib64", read_only, 0);
    allow_path(ruleset, "/opt/signhere-seal", read_only, 1);
    allow_path(ruleset, "/app/dist", read_only, 1);
    allow_path(ruleset, "/app/node_modules", read_only, 1);
    allow_path(ruleset, "/app/scripts", read_only, 1);
    allow_path(ruleset, "/app/package.json", LANDLOCK_ACCESS_FS_READ_FILE, 1);
    allow_path(ruleset, "/etc/ld.so.cache", LANDLOCK_ACCESS_FS_READ_FILE, 0);
    allow_path(ruleset, "/etc/localtime", LANDLOCK_ACCESS_FS_READ_FILE, 0);
    allow_path(ruleset, "/etc/timezone", LANDLOCK_ACCESS_FS_READ_FILE, 0);
    allow_path(ruleset, "/etc/ssl/certs", LANDLOCK_ACCESS_FS_READ_FILE | LANDLOCK_ACCESS_FS_READ_DIR, 0);
    allow_path(ruleset, "/dev/null", LANDLOCK_ACCESS_FS_READ_FILE | LANDLOCK_ACCESS_FS_WRITE_FILE, 1);
    allow_path(ruleset, "/dev/urandom", LANDLOCK_ACCESS_FS_READ_FILE, 1);
    allow_path(ruleset, "/dev/random", LANDLOCK_ACCESS_FS_READ_FILE, 0);
    /* Uploaded/extracted job files are never executable. Device creation is not needed. */
    allow_path(ruleset, job, all_rights & ~(LANDLOCK_ACCESS_FS_EXECUTE | LANDLOCK_ACCESS_FS_MAKE_CHAR | LANDLOCK_ACCESS_FS_MAKE_BLOCK | LANDLOCK_ACCESS_FS_MAKE_SOCK), 1);
    if (syscall(SYS_landlock_restrict_self, ruleset, 0) < 0) fail("cannot restrict filesystem access");
    if (close(ruleset) < 0) fail("cannot close filesystem rules descriptor");
}

/* fchmodat2 exists on newer hosts even with Debian 6.1 build headers. */
#ifndef __NR_fchmodat2
#define __NR_fchmodat2 452
#endif
#ifndef __NR_setxattrat
#define __NR_setxattrat 463
#endif
#ifndef __NR_removexattrat
#define __NR_removexattrat 466
#endif

#define REJECT_SYSCALL(name) BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, __NR_##name, 0, 1), BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_ERRNO | EPERM)
static void restrict_syscalls(void) {
    const struct sock_filter filters[] = {
        BPF_STMT(BPF_LD | BPF_W | BPF_ABS, offsetof(struct seccomp_data, arch)),
        BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, EXPECTED_ARCH, 1, 0),
        BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_KILL_PROCESS),
        BPF_STMT(BPF_LD | BPF_W | BPF_ABS, offsetof(struct seccomp_data, nr)),
#if defined(__x86_64__)
        /* Do not permit x32 ABI syscall numbers through an x86_64 policy. */
        BPF_JUMP(BPF_JMP | BPF_JGE | BPF_K, 0x40000000U, 0, 1),
        BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_KILL_PROCESS),
#endif
        /* glibc falls back to clone when clone3 is unavailable. */
        BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, __NR_clone3, 0, 1),
        BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_ERRNO | ENOSYS),
        /* Permit runtime threads, never new processes or namespace creation. */
        BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, __NR_clone, 0, 5),
        BPF_STMT(BPF_LD | BPF_W | BPF_ABS, offsetof(struct seccomp_data, args[0])),
        BPF_JUMP(BPF_JMP | BPF_JSET | BPF_K, CLONE_NEWCGROUP | CLONE_NEWIPC | CLONE_NEWNET | CLONE_NEWNS | CLONE_NEWPID | CLONE_NEWUSER | CLONE_NEWUTS, 0, 1),
        BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_ERRNO | EPERM),
        BPF_JUMP(BPF_JMP | BPF_JSET | BPF_K, CLONE_THREAD, 1, 0),
        BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_ERRNO | EPERM),
        BPF_STMT(BPF_LD | BPF_W | BPF_ABS, offsetof(struct seccomp_data, nr)),
#ifdef __NR_fork
        REJECT_SYSCALL(fork),
#endif
#ifdef __NR_vfork
        REJECT_SYSCALL(vfork),
#endif
        /* asyncio uses an anonymous Unix socket pair for its own wake-up pipe.
         * It cannot reach a peer outside the process: socket/connect/bind remain denied. */
        BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, __NR_socketpair, 0, 3),
        BPF_STMT(BPF_LD | BPF_W | BPF_ABS, offsetof(struct seccomp_data, args[0])),
        BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, AF_UNIX, 1, 0),
        BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_ERRNO | EPERM),
        BPF_STMT(BPF_LD | BPF_W | BPF_ABS, offsetof(struct seccomp_data, nr)),
        /* setrlimit/getrlimit use prlimit64(0, ...); never target the parent. */
        BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, __NR_prlimit64, 0, 3),
        BPF_STMT(BPF_LD | BPF_W | BPF_ABS, offsetof(struct seccomp_data, args[0])),
        BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, 0, 1, 0),
        BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_ERRNO | EPERM),
        BPF_STMT(BPF_LD | BPF_W | BPF_ABS, offsetof(struct seccomp_data, nr)),
        /* Prevent asynchronous-I/O signals targeting another process. */
        BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, __NR_fcntl, 0, 6),
        BPF_STMT(BPF_LD | BPF_W | BPF_ABS, offsetof(struct seccomp_data, args[1])),
        BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, F_SETOWN, 3, 0),
        BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, F_SETOWN_EX, 2, 0),
        BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, F_SETSIG, 1, 0),
        BPF_STMT(BPF_JMP | BPF_JA, 1),
        BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_ERRNO | EPERM),
        BPF_STMT(BPF_LD | BPF_W | BPF_ABS, offsetof(struct seccomp_data, nr)),
        BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, __NR_fcntl, 0, 5),
        BPF_STMT(BPF_LD | BPF_W | BPF_ABS, offsetof(struct seccomp_data, args[1])),
        BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, F_SETFL, 0, 3),
        BPF_STMT(BPF_LD | BPF_W | BPF_ABS, offsetof(struct seccomp_data, args[2])),
        BPF_JUMP(BPF_JMP | BPF_JSET | BPF_K, O_ASYNC, 0, 1),
        BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_ERRNO | EPERM),
        BPF_STMT(BPF_LD | BPF_W | BPF_ABS, offsetof(struct seccomp_data, nr)),
        REJECT_SYSCALL(socket), REJECT_SYSCALL(connect),
        REJECT_SYSCALL(bind), REJECT_SYSCALL(listen), REJECT_SYSCALL(accept), REJECT_SYSCALL(accept4),
        REJECT_SYSCALL(ptrace), REJECT_SYSCALL(process_vm_readv), REJECT_SYSCALL(process_vm_writev),
        REJECT_SYSCALL(pidfd_open), REJECT_SYSCALL(pidfd_getfd), REJECT_SYSCALL(kcmp),
        REJECT_SYSCALL(kill), REJECT_SYSCALL(tkill), REJECT_SYSCALL(tgkill),
        REJECT_SYSCALL(rt_sigqueueinfo), REJECT_SYSCALL(rt_tgsigqueueinfo), REJECT_SYSCALL(pidfd_send_signal),
        REJECT_SYSCALL(ioctl),
#ifdef __NR_chmod
        REJECT_SYSCALL(chmod),
#endif
        REJECT_SYSCALL(fchmod), REJECT_SYSCALL(fchmodat), REJECT_SYSCALL(fchmodat2),
#ifdef __NR_chown
        REJECT_SYSCALL(chown),
#endif
#ifdef __NR_lchown
        REJECT_SYSCALL(lchown),
#endif
        REJECT_SYSCALL(fchown), REJECT_SYSCALL(fchownat),
#ifdef __NR_utime
        REJECT_SYSCALL(utime),
#endif
#ifdef __NR_utimes
        REJECT_SYSCALL(utimes),
#endif
#ifdef __NR_futimesat
        REJECT_SYSCALL(futimesat),
#endif
        REJECT_SYSCALL(utimensat),
        REJECT_SYSCALL(setxattr), REJECT_SYSCALL(lsetxattr), REJECT_SYSCALL(fsetxattr),
        REJECT_SYSCALL(removexattr), REJECT_SYSCALL(lremovexattr), REJECT_SYSCALL(fremovexattr),
        REJECT_SYSCALL(setxattrat), REJECT_SYSCALL(removexattrat),
        REJECT_SYSCALL(sched_setaffinity), REJECT_SYSCALL(sched_setparam), REJECT_SYSCALL(sched_setscheduler),
        REJECT_SYSCALL(sched_setattr), REJECT_SYSCALL(setpriority), REJECT_SYSCALL(ioprio_set),
        REJECT_SYSCALL(setpgid), REJECT_SYSCALL(setsid), REJECT_SYSCALL(migrate_pages), REJECT_SYSCALL(move_pages),
        REJECT_SYSCALL(unshare), REJECT_SYSCALL(setns), REJECT_SYSCALL(mount), REJECT_SYSCALL(umount2),
        REJECT_SYSCALL(pivot_root), REJECT_SYSCALL(chroot),
        REJECT_SYSCALL(bpf), REJECT_SYSCALL(perf_event_open), REJECT_SYSCALL(userfaultfd),
        REJECT_SYSCALL(io_uring_setup), REJECT_SYSCALL(io_uring_register), REJECT_SYSCALL(io_uring_enter),
        REJECT_SYSCALL(open_by_handle_at), REJECT_SYSCALL(name_to_handle_at),
        REJECT_SYSCALL(keyctl), REJECT_SYSCALL(add_key), REJECT_SYSCALL(request_key),
        BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_ALLOW),
    };
    const struct sock_fprog program = { .len = (unsigned short)(sizeof(filters) / sizeof(filters[0])), .filter = (struct sock_filter *)filters };
    if (prctl(PR_SET_SECCOMP, SECCOMP_MODE_FILTER, &program) < 0) fail("cannot enforce syscall filter");
}

int main(int argc, char **argv) {
    if (argc < 3 || argv[1][0] != '/' || argv[2][0] != '/') { errno = EINVAL; fail("expected absolute job directory and executable"); }
    char job[PATH_MAX];
    if (realpath(argv[1], job) == NULL) fail("cannot resolve job directory");
    struct stat info;
    if (strncmp(job, "/tmp/", 5) != 0 || job[5] == '\0' || lstat(job, &info) < 0 ||
        !S_ISDIR(info.st_mode) || info.st_uid != geteuid() || (info.st_mode & 077) != 0) {
        errno = EPERM; fail("job directory must be private, owned by this user, and below /tmp");
    }
    if (syscall(SYS_close_range, 3U, ~0U, 0U) < 0) fail("cannot close inherited file descriptors");
    if (chdir(job) < 0) fail("cannot enter job directory");
    umask(077);
    if (prctl(PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0) < 0) fail("cannot enable no-new-privileges");
    /* exec resets dumpability; RLIMIT_CORE, seccomp and /proc denial enforce the child boundary. */
    if (prctl(PR_SET_DUMPABLE, 0) < 0) fail("cannot set launcher dumpability");
    limit_resource(RLIMIT_CORE, 0);
    limit_resource(RLIMIT_CPU, 30);
    limit_resource(RLIMIT_FSIZE, 40ULL * 1024 * 1024);
    limit_resource(RLIMIT_NOFILE, 64);
    /* V8/WASM reserves substantial virtual memory. This is not a 64 GiB RSS
     * allowance: the container cgroup separately caps all resident/native memory. */
    const char *base = strrchr(argv[2], '/');
    const int is_node = base != NULL && strcmp(base + 1, "node") == 0;
    limit_resource(RLIMIT_AS, is_node ? 64ULL * 1024 * 1024 * 1024 : 768ULL * 1024 * 1024);
    if (clearenv() != 0 || setenv("PATH", "/usr/local/bin:/usr/bin:/bin", 1) != 0 ||
        setenv("HOME", job, 1) != 0 || setenv("TMPDIR", job, 1) != 0 ||
        setenv("LANG", "C.UTF-8", 1) != 0 || setenv("TZ", "UTC", 1) != 0 ||
        setenv("NODE_ENV", "production", 1) != 0 || setenv("UV_THREADPOOL_SIZE", "1", 1) != 0 ||
        setenv("PYTHONNOUSERSITE", "1", 1) != 0 || setenv("PYTHONDONTWRITEBYTECODE", "1", 1) != 0) fail("cannot clear child environment");
    restrict_filesystem(job);
    restrict_syscalls();
    if (is_node) {
        execv(argv[2], &argv[2]);
    } else {
        /* Python isolated mode disables cwd/user-site/PYTHON* import injection. */
        char **python_args = calloc((size_t)argc, sizeof(char *));
        if (python_args == NULL) fail("cannot allocate isolated arguments");
        python_args[0] = argv[2];
        python_args[1] = "-I";
        for (int index = 3; index < argc; index++) python_args[index - 1] = argv[index];
        execv(argv[2], python_args);
    }
    fail("cannot execute parser runtime");
}
