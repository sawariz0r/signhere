FROM postgres:17-bookworm
# The role scripts are part of the image rather than bind mounts: Coolify runs Compose
# from a directory without the repository, where a missing mount source becomes an
# empty directory and the scripts silently do nothing.
COPY 10-signhere-roles.sh /docker-entrypoint-initdb.d/10-signhere-roles.sh
COPY upgrade-legacy-roles.sh /usr/local/share/signhere/upgrade-legacy-roles.sh
