#!/usr/bin/env python3
"""Signhere's bounded local PDF seal implementation (pyHanko 0.37).

Commands consume one JSON request on stdin. No private key material is returned.
prepare/verify parse PDF and must run in the deployment's unprivileged sandbox;
cms reads a bounded prepared file and maintained-library CMS, never parses PDF.
"""
import asyncio
import hashlib
import io
import json
import logging
import os
import re
import sys
import secrets
import stat
from datetime import datetime, timedelta, timezone
from pathlib import Path

MAX_PDF = 32 * 1024 * 1024
MAX_MANIFEST = 16 * 1024
MAX_REQUEST = 64 * 1024
CONTENTS_HEX = 65536
MAX_TAIL = 96 * 1024
PROFILE = 'signhere-seal-v1'
logging.disable(logging.CRITICAL)


class SealError(ValueError):
    pass


class SealInputError(SealError):
    pass


def fail_input(message):
    raise SealInputError(message)


def fail(message):
    raise SealError(message)


def bounded_read(path, limit):
    before = os.lstat(path)
    if not stat.S_ISREG(before.st_mode) or stat.S_ISLNK(before.st_mode) or before.st_nlink != 1:
        fail('Input must be a regular file without extra hard links')
    fd = os.open(path, os.O_RDONLY | getattr(os, 'O_NOFOLLOW', 0) | getattr(os, 'O_BINARY', 0))
    with os.fdopen(fd, 'rb') as source:
        initial = os.fstat(source.fileno())
        if initial.st_ino != before.st_ino or initial.st_dev != before.st_dev or initial.st_nlink != 1 or initial.st_size > limit:
            fail('Input changed or exceeds its size limit')
        result = source.read(limit + 1)
        after = os.fstat(source.fileno())
        if len(result) != initial.st_size or after.st_size != initial.st_size or after.st_mtime_ns != initial.st_mtime_ns or after.st_ctime_ns != initial.st_ctime_ns or after.st_nlink != 1:
            fail('Input changed while being read')
    if len(result) > limit:
        fail('Input exceeds its size limit')
    return result


def strict_json(data):
    def pairs(items):
        result = {}
        for key, value in items:
            if key in result:
                fail('Duplicate JSON key')
            result[key] = value
        return result
    text = data.decode('utf-8', errors='strict')
    if text.startswith('\ufeff'):
        fail('JSON BOM is unsupported')
    value = json.loads(text, object_pairs_hook=pairs,
                       parse_constant=lambda _: fail('Non-finite JSON number'))
    # Reject unpaired surrogates, including those introduced by JSON escapes.
    json.dumps(value, ensure_ascii=False).encode('utf-8', errors='strict')
    return value


def canonical(value):
    return json.dumps(value, ensure_ascii=False, sort_keys=True,
                      separators=(',', ':'), allow_nan=False).encode('utf-8')


def fingerprint(cert):
    from cryptography.hazmat.primitives import hashes
    return cert.fingerprint(hashes.SHA256()).hex()


def identity(p12_file, password_file=None, require_current=False):
    from cryptography.hazmat.primitives.serialization import pkcs12, Encoding
    from cryptography.hazmat.primitives.asymmetric import rsa, ec
    password = bounded_read(password_file, 4096).rstrip(b'\r\n') if password_file else None
    key, cert, chain = pkcs12.load_key_and_certificates(bounded_read(p12_file, 1024 * 1024), password)
    if key is None or cert is None:
        fail('PKCS12 must contain a private key and signing certificate')
    if isinstance(key, rsa.RSAPrivateKey):
        if key.key_size < 2048:
            fail('RSA signing key must be at least 2048 bits')
        algorithm = 'RSA-' + str(key.key_size)
    elif isinstance(key, ec.EllipticCurvePrivateKey) and key.curve.name in ('secp256r1', 'secp384r1'):
        algorithm = 'ECDSA-' + key.curve.name
    else:
        fail('Unsupported signing key algorithm')
    from cryptography.hazmat.primitives.serialization import PublicFormat
    if key.public_key().public_bytes(Encoding.DER, PublicFormat.SubjectPublicKeyInfo) != cert.public_key().public_bytes(Encoding.DER, PublicFormat.SubjectPublicKeyInfo):
        fail('Private key does not match certificate')
    from cryptography import x509
    try:
        usage = cert.extensions.get_extension_for_class(x509.KeyUsage).value
        if not (usage.digital_signature or usage.content_commitment):
            fail('Certificate does not permit document signatures')
    except x509.ExtensionNotFound:
        fail('Certificate must declare signing key usage')
    if require_current and not (cert.not_valid_before_utc <= datetime.now(timezone.utc) < cert.not_valid_after_utc):
        fail('Signing certificate is not currently valid')
    meta = {'fingerprintSha256': fingerprint(cert), 'certificatePem': cert.public_bytes(Encoding.PEM).decode('ascii'),
            'chainPem': ''.join(c.public_bytes(Encoding.PEM).decode('ascii') for c in (cert, *(chain or []))),
            'notBefore': cert.not_valid_before_utc.isoformat(), 'notAfter': cert.not_valid_after_utc.isoformat(),
            'keyAlgorithm': algorithm}
    return key, cert, chain or [], password, meta


def atomic_new(path, content, mode=0o600):
    path = Path(path)
    staging = path.with_name('.' + path.name + '.' + secrets.token_hex(16) + '.tmp')
    fd = os.open(staging, os.O_WRONLY | os.O_CREAT | os.O_EXCL, mode)
    try:
        with os.fdopen(fd, 'wb') as output:
            output.write(content)
            output.flush()
            os.fsync(output.fileno())
        # Hard-link publication is atomic and fails if the target already exists;
        # unlike rename/replace it cannot silently replace a concurrent identity.
        os.link(staging, path)
        if os.name == 'posix':
            directory_fd = os.open(path.parent, os.O_RDONLY | os.O_DIRECTORY)
            try:
                os.fsync(directory_fd)
            finally:
                os.close(directory_fd)
    finally:
        staging.unlink(missing_ok=True)


def create_identity(request):
    from cryptography import x509
    from cryptography.x509.oid import NameOID
    from cryptography.hazmat.primitives import hashes, serialization
    from cryptography.hazmat.primitives.asymmetric import rsa
    from cryptography.hazmat.primitives.serialization import pkcs12
    installation = request['installationId']
    if not isinstance(installation, str) or not re.fullmatch(r'[A-Za-z0-9-]{1,50}', installation):
        fail('Invalid installation ID')
    directory = Path(request['directory'])
    directory.mkdir(mode=0o700, parents=True, exist_ok=True)
    key = rsa.generate_private_key(public_exponent=65537, key_size=3072)
    subject = x509.Name([x509.NameAttribute(NameOID.ORGANIZATION_NAME, 'Signhere installation'),
                         x509.NameAttribute(NameOID.COMMON_NAME, 'Signhere seal ' + installation)])
    now = datetime.now(timezone.utc)
    cert = (x509.CertificateBuilder().subject_name(subject).issuer_name(subject).public_key(key.public_key())
            .serial_number(x509.random_serial_number()).not_valid_before(now - timedelta(minutes=5))
            .not_valid_after(now + timedelta(days=3650))
            .add_extension(x509.BasicConstraints(ca=False, path_length=None), critical=True)
            .add_extension(x509.KeyUsage(digital_signature=True, content_commitment=True, key_encipherment=False,
                           data_encipherment=False, key_agreement=False, key_cert_sign=False, crl_sign=False,
                           encipher_only=False, decipher_only=False), critical=True)
            .add_extension(x509.SubjectKeyIdentifier.from_public_key(key.public_key()), critical=False)
            .sign(key, hashes.SHA256()))
    payload = pkcs12.serialize_key_and_certificates(b'Signhere installation seal', key, cert, None, serialization.NoEncryption())
    # The caller owns exclusive first-boot/rotation directory provisioning. O_EXCL
    # prevents concurrent writers from replacing an existing identity.
    atomic_new(directory / 'identity.p12', payload)
    atomic_new(directory / 'certificate.pem', cert.public_bytes(serialization.Encoding.PEM), 0o644)
    return identity(directory / 'identity.p12')[4]


def check_manifest(manifest):
    if not isinstance(manifest, dict) or len(canonical(manifest)) > MAX_MANIFEST:
        fail('Invalid seal manifest')
    if manifest.get('schema') != PROFILE or manifest.get('evidenceSchema') != 2:
        fail('Unsupported seal manifest schema')
    for name in ('evidenceDigest', 'preparedHash', 'certificateFingerprint'):
        if not isinstance(manifest.get(name), str) or not re.fullmatch(r'[0-9a-f]{64}', manifest[name]):
            fail('Invalid manifest digest: ' + name)
    checkpoint = manifest.get('checkpoint')
    if not isinstance(checkpoint, dict) or type(checkpoint.get('sequence')) is not int or checkpoint['sequence'] < 1 or not re.fullmatch(r'[0-9a-f]{64}', str(checkpoint.get('hash', ''))):
        fail('Invalid signing checkpoint')
    policy = manifest.get('policy')
    if policy == {'timestamp': 'off'}:
        if 'approvalReceipts' in manifest:
            fail('Approval receipts require an independent-approval policy')
    elif policy == {'timestamp': 'off', 'independentApproval': 'email'}:
        # The seal commits to each participant's central approval receipt (SHA-256 of the exact JWS).
        receipts = manifest.get('approvalReceipts')
        # Empty when every participant used an identity-verifying method instead.
        if not isinstance(receipts, list) or len(receipts) > 100:
            fail('Invalid approval receipt commitments')
        seen = set()
        for item in receipts:
            if not isinstance(item, dict) or set(item) != {'recipientId', 'receiptSha256'} \
                    or not isinstance(item['recipientId'], str) or not re.fullmatch(r'[A-Za-z0-9-]{1,80}', item['recipientId']) \
                    or not isinstance(item['receiptSha256'], str) or not re.fullmatch(r'[0-9a-f]{64}', item['receiptSha256']) \
                    or item['recipientId'] in seen:
                fail('Invalid approval receipt commitment')
            seen.add(item['recipientId'])
    else:
        fail('This release supports timestamp policy off only; required timestamping is unavailable')
    allowed = {'schema', 'evidenceSchema', 'installationId', 'documentId', 'evidenceDigest', 'preparedHash', 'checkpoint', 'certificateFingerprint', 'policy', 'approvalReceipts'}
    if set(manifest) - allowed:
        fail('Unknown seal manifest member')
    for name in ('documentId', 'installationId'):
        if not isinstance(manifest.get(name), str) or not re.fullmatch(r'[A-Za-z0-9-]{1,80}', manifest[name]):
            fail('Invalid manifest identifier')
    return manifest


async def prepare(request):
    from asn1crypto import pem, x509
    from pyhanko.pdf_utils import generic
    from pyhanko.pdf_utils.incremental_writer import IncrementalPdfFileWriter
    from pyhanko.pdf_utils.reader import PdfFileReader
    from pyhanko.sign import signers, fields
    from pyhanko_certvalidator.registry import SimpleCertificateStore
    data = bounded_read(request['input'], MAX_PDF)
    reader = PdfFileReader(io.BytesIO(data), strict=True)
    if reader.encrypted or reader.embedded_signatures or list(fields.enumerate_sig_fields(reader)):
        fail_input('Input must be an unencrypted unsigned prepared PDF')
    if '/SignhereSeal' in reader.root:
        fail_input('Input already contains a Signhere manifest')
    manifest = check_manifest(request['manifest'])
    cert_bytes = bounded_read(request['certificateFile'], 1024 * 1024)
    chain = [x509.Certificate.load(der) for type_name, _, der in pem.unarmor(cert_bytes, multiple=True) if type_name == 'CERTIFICATE']
    if not chain or hashlib.sha256(chain[0].dump()).hexdigest() != manifest['certificateFingerprint']:
        fail('Manifest certificate does not match public identity')
    registry = SimpleCertificateStore()
    registry.register_multiple(chain[1:])
    public_signer = signers.ExternalSigner(chain[0], registry, signature_value=max(512, (chain[0].public_key.bit_size + 7) // 8 + 32))
    # Fixed placeholders bypass pyHanko's usual size estimate. A public-only CMS
    # dry run catches oversized imported chains before anybody approves a PDF.
    dummy_cms = await public_signer.async_sign(bytes(32), 'sha256', dry_run=True, use_pades=True)
    if len(dummy_cms.dump()) * 2 > CONTENTS_HEX:
        fail('Configured signing certificate chain exceeds seal capacity')
    writer = IncrementalPdfFileWriter(io.BytesIO(data), strict=True)
    writer.root[generic.pdf_name('/SignhereSeal')] = writer.add_object(generic.StreamObject(
        {generic.pdf_name('/Type'): generic.pdf_name('/SignhereSeal'), generic.pdf_name('/Version'): generic.NumberObject(1)}, stream_data=canonical(manifest)))
    writer.update_root()
    metadata = signers.PdfSignatureMetadata(field_name='SignherePlatformSeal', md_algorithm='sha256',
        name='Signhere installation seal', reason='Sealing completed document and evidence; not an individual signature',
        certify=False, subfilter=fields.SigSeedSubFilter.PADES)
    pdf_signer = signers.PdfSigner(metadata, public_signer, new_field_spec=fields.SigFieldSpec('SignherePlatformSeal', box=(0, 0, 0, 0)))
    with open(request['output'], 'xb+') as output:
        digest, _, _ = await pdf_signer.async_digest_doc_for_signing(writer, bytes_reserved=CONTENTS_HEX, output=output)
        if output.seek(0, os.SEEK_END) - len(data) > MAX_TAIL:
            fail_input('Prepared PDF exceeds the incremental sealing budget')
    return {'digest': digest.document_digest.hex(), 'start': digest.reserved_region_start,
            'end': digest.reserved_region_end, 'inputHash': hashlib.sha256(data).hexdigest(), 'inputLength': len(data)}


async def cms_sign(request):
    from pyhanko.sign import signers
    from pyhanko.sign.signers.pdf_byterange import PreparedByteRangeDigest
    data = bounded_read(request['input'], MAX_PDF)
    candidate_length = request.get('candidateLength')
    candidate_hash = request.get('candidateSha256')
    if type(candidate_length) is not int or candidate_length < 8 or candidate_length >= len(data) or len(data) - candidate_length > MAX_TAIL or not isinstance(candidate_hash, str) or not re.fullmatch(r'[0-9a-f]{64}', candidate_hash):
        fail('Invalid candidate length or incremental tail budget')
    if hashlib.sha256(data[:candidate_length]).hexdigest() != candidate_hash:
        fail('Prepared PDF differs from the approved candidate')
    start, end = request['start'], request['end']
    if type(start) is not int or type(end) is not int or start < candidate_length or end - start != CONTENTS_HEX + 2 or end >= len(data):
        fail('Invalid reserved signature bounds')
    if data[start:end] != b'<' + b'0' * CONTENTS_HEX + b'>':
        fail('Signature placeholder is invalid')
    digest = hashlib.sha256(data[:start] + data[end:]).digest()
    if digest.hex() != request['digest']:
        fail('Prepared signature digest changed')
    key, cert, chain, _, meta = identity(request['p12File'], request.get('passwordFile'), require_current=True)
    if meta['fingerprintSha256'] != request['expectedFingerprint']:
        fail('Sealing identity fingerprint mismatch')
    # Use the already captured key/certificate, never reopen a mutable secret path.
    from cryptography.hazmat.primitives.serialization import Encoding, PrivateFormat, NoEncryption
    from asn1crypto import keys as asn1keys, x509 as asn1x509
    from pyhanko_certvalidator.registry import SimpleCertificateStore
    registry = SimpleCertificateStore()
    registry.register_multiple(asn1x509.Certificate.load(item.public_bytes(Encoding.DER)) for item in chain)
    signer = signers.SimpleSigner(signing_cert=asn1x509.Certificate.load(cert.public_bytes(Encoding.DER)),
        signing_key=asn1keys.PrivateKeyInfo.load(key.private_bytes(Encoding.DER, PrivateFormat.PKCS8, NoEncryption())), cert_registry=registry)
    signed = await signer.async_sign(digest, 'sha256', use_pades=True)
    output = io.BytesIO(data)
    PreparedByteRangeDigest(digest, start, end).fill_with_cms(output, signed)
    sealed = output.getvalue()
    atomic_new(request['output'], sealed)
    return {**meta, 'outputHash': hashlib.sha256(sealed).hexdigest(), 'outputLength': len(sealed)}


def verify(request):
    from cryptography import x509 as crypto_x509
    from cryptography.hazmat.primitives.serialization import Encoding
    from pyhanko.pdf_utils import generic
    from pyhanko.pdf_utils.reader import PdfFileReader
    from pyhanko.sign import fields
    from pyhanko.sign.validation import validate_pdf_signature
    from pyhanko.sign.validation.status import SignatureCoverageLevel
    from pyhanko.sign.validation.settings import KeyUsageConstraints
    from pyhanko_certvalidator import ValidationContext
    data = bounded_read(request['input'], MAX_PDF)
    reader = PdfFileReader(io.BytesIO(data), strict=True)
    if reader.encrypted:
        fail('Encrypted signed PDFs are unsupported')
    signatures = reader.embedded_signatures
    all_fields = list(fields.enumerate_sig_fields(reader))
    if len(signatures) != 1 or len(all_fields) != 1:
        fail('Signhere profile requires exactly one signature field and signature')
    signature = signatures[0]
    if signature.field_name != 'SignherePlatformSeal' or signature.sig_object.get('/SubFilter') != '/ETSI.CAdES.detached':
        fail('Unsupported signature profile')
    from asn1crypto import cms
    parsed_cms = cms.ContentInfo.load(signature.pkcs7_content)
    der = parsed_cms.dump()
    if not signature.pkcs7_content.startswith(der) or any(signature.pkcs7_content[len(der):]):
        fail('Signature Contents has nonzero trailing data')
    if len(signature.signed_data['signer_infos']) != 1:
        fail('Exactly one CMS signer is required')
    ranges = [int(x) for x in signature.sig_object['/ByteRange']]
    if len(ranges) != 4 or ranges[0] != 0 or ranges[1] <= 0 or ranges[2] <= ranges[1] or ranges[3] <= 0 or ranges[2] + ranges[3] != len(data):
        fail('Signature must cover the entire file except its Contents value')
    contents = signature.pkcs7_content
    excluded = data[ranges[1]:ranges[2]]
    if len(excluded) != 2 * len(contents) + 2 or excluded[:1] != b'<' or excluded[-1:] != b'>':
        fail('ByteRange gap must be exactly the signature Contents value')
    try:
        if bytes.fromhex(excluded[1:-1].decode('ascii')) != contents:
            fail('Excluded bytes do not match the parsed CMS Contents')
    except (UnicodeError, ValueError):
        fail('Invalid hexadecimal signature Contents')
    if signature.evaluate_signature_coverage() != SignatureCoverageLevel.ENTIRE_FILE:
        fail('Unsigned revisions, extra tails or nonstandard signature coverage are unsupported')
    if signature.md_algorithm != 'sha256':
        fail('Unsupported document digest algorithm')
    # Trust is deliberately not inferred from an embedded certificate. An empty
    # trust store disables system roots and all certificate-directed fetching.
    status = validate_pdf_signature(signature, signer_validation_context=ValidationContext(
        trust_roots=[], allow_fetching=False, revocation_mode='soft-fail'),
        key_usage_settings=KeyUsageConstraints(key_usage={'non_repudiation', 'digital_signature'}, match_all_key_usages=False), skip_diff=True)
    if not status.intact or not status.valid:
        fail('PDF content digest or CMS signature is invalid')
    signer_info = signature.signed_data['signer_infos'][0]
    if signer_info['signature_algorithm']['algorithm'].native not in ('sha256_rsa', 'rsassa_pkcs1v15', 'sha256_ecdsa'):
        fail('Unsupported CMS signature algorithm')
    attrs = signer_info['signed_attrs']
    types = [x['type'].native for x in attrs]
    if any(types.count(t) != 1 for t in ('content_type', 'message_digest', 'signing_certificate_v2')):
        fail('Required unambiguous signed attributes are missing')
    # The signingCertificateV2 attribute is validated by pyHanko as part of CMS
    # validation; no implementation of ASN.1 signature arithmetic lives here.
    if signer_info['unsigned_attrs'].native:
        fail('This profile does not support unsigned CMS attributes or timestamping')
    cert = crypto_x509.load_der_x509_certificate(signature.signer_cert.dump())
    from cryptography.hazmat.primitives.asymmetric import rsa, ec
    public_key = cert.public_key()
    if not ((isinstance(public_key, rsa.RSAPublicKey) and public_key.key_size >= 2048) or (isinstance(public_key, ec.EllipticCurvePublicKey) and public_key.curve.name in ('secp256r1', 'secp384r1'))):
        fail('Unsupported or weak public key')
    actual_fingerprint = fingerprint(cert)
    manifest_object = reader.root['/SignhereSeal'] if '/SignhereSeal' in reader.root else None
    if not isinstance(manifest_object, generic.StreamObject) or manifest_object.get('/Type') != '/SignhereSeal' or manifest_object.get('/Filter') is not None:
        fail('Missing or unsupported protected seal manifest')
    manifest_bytes = manifest_object.data
    if len(manifest_bytes) > MAX_MANIFEST:
        fail('Protected seal manifest exceeds its size limit')
    manifest = check_manifest(strict_json(manifest_bytes))
    if manifest['certificateFingerprint'] != actual_fingerprint:
        fail('Protected identity does not match CMS certificate')
    if request.get('expectedManifest') is not None and manifest != request['expectedManifest']:
        fail('Protected manifest differs from expected evidence')
    expected = request.get('expectedFingerprint')
    if expected is not None and (not re.fullmatch(r'[0-9a-f]{64}', expected) or expected != actual_fingerprint):
        fail('Signing certificate does not match the independently supplied fingerprint')
    evidence = 'not-supplied'
    if request.get('evidenceCoreFile'):
        core = bounded_read(request['evidenceCoreFile'], 32 * 1024 * 1024)
        if hashlib.sha256(core).hexdigest() != manifest['evidenceDigest']:
            fail('Detached evidence does not match protected commitment')
        strict_json(core)
        evidence = 'digest-matched'
    prepared = 'not-supplied'
    if request.get('preparedPdfFile'):
        original = bounded_read(request['preparedPdfFile'], MAX_PDF)
        if hashlib.sha256(original).hexdigest() != manifest['preparedHash']:
            fail('Prepared PDF does not match protected commitment')
        prepared = 'digest-matched'
    return {'profile': PROFILE, 'integrity': 'valid', 'coverage': 'entire-file',
            'issuerTrust': 'pinned' if expected else 'unknown', 'timestamp': 'absent',
            'certificateFingerprint': actual_fingerprint, 'certificatePem': cert.public_bytes(Encoding.PEM).decode('ascii'),
            'certificateValidity': 'current' if cert.not_valid_before_utc <= datetime.now(timezone.utc) < cert.not_valid_after_utc else 'outside-current-validity',
            'manifest': manifest, 'evidence': evidence, 'preparedPdf': prepared,
            'pdfHash': hashlib.sha256(data).hexdigest(), 'identityVerified': False,
            'qualifiedSignature': False, 'revocation': 'not-checked'}


def main():
    # Enforce actual address-space/CPU limits on Unix. These limit exhaustion,
    # not private-file access; deployment must isolate parse/verify operations.
    if os.name == 'posix':
        import resource
        resource.setrlimit(resource.RLIMIT_AS, (768 * 1024 * 1024, 768 * 1024 * 1024))
        resource.setrlimit(resource.RLIMIT_CPU, (30, 30))
        resource.setrlimit(resource.RLIMIT_FSIZE, (MAX_PDF + 1024 * 1024, MAX_PDF + 1024 * 1024))
    request = strict_json(sys.stdin.buffer.read(MAX_REQUEST + 1))
    if len(canonical(request)) > MAX_REQUEST:
        fail('IPC request too large')
    operation = sys.argv[1] if len(sys.argv) == 2 else ''
    if operation == 'create':
        result = create_identity(request)
    elif operation == 'inspect':
        result = identity(request['p12File'], request.get('passwordFile'))[4]
    elif operation == 'prepare':
        result = asyncio.run(prepare(request))
    elif operation == 'cms':
        result = asyncio.run(cms_sign(request))
    elif operation == 'verify':
        result = verify(request)
    else:
        fail('Unknown engine operation')
    print(json.dumps({'ok': True, 'result': result}, ensure_ascii=True, separators=(',', ':')))


if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        # Only a known PDF-read error in prepare, or an explicit input rejection,
        # is a client input error. Secret/config/IO/program/runtime failures retain
        # a service error code; never classify a blanket ValueError as bad PDF.
        pdf_misc = sys.modules.get('pyhanko.pdf_utils.misc')
        parser_rejection = (len(sys.argv) == 2 and sys.argv[1] == 'prepare' and pdf_misc
                            and isinstance(error, pdf_misc.PdfReadError))
        invalid_input = isinstance(error, SealInputError) or parser_rejection
        code = 'INVALID_PDF' if invalid_input else 'SEAL_REJECTED' if isinstance(error, SealError) else 'ENGINE_FAILURE'
        message = str(error) if isinstance(error, SealError) else 'Unsupported or malformed prepared PDF.' if invalid_input else 'PDF seal engine operation failed.'
        print(json.dumps({'ok': False, 'errorCode': code, 'error': message}, ensure_ascii=True))
        sys.exit(1)
