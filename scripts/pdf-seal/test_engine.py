import importlib.util
import asyncio
import hashlib
import io
import tempfile
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path
from cryptography import x509
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import ec, rsa
from cryptography.hazmat.primitives.serialization import pkcs12
from cryptography.x509.oid import NameOID
from pyhanko.pdf_utils import writer, generic
from pyhanko.pdf_utils.reader import PdfFileReader

spec = importlib.util.spec_from_file_location('engine', Path(__file__).with_name('engine.py'))
e = importlib.util.module_from_spec(spec)
spec.loader.exec_module(e)

class EngineAdversarialTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='signhere-seal-engine-')
        self.directory = Path(self.temp.name)
        w = writer.PdfFileWriter()
        content = w.add_object(generic.StreamObject(stream_data=b'q 0 0 50 50 re S Q'))
        w.insert_page(writer.PageObject(content, [0, 0, 595, 842]))
        with (self.directory / 'input.pdf').open('wb') as target:
            w.write(target)
    def tearDown(self):
        self.temp.cleanup()
    def key(self, expired=False, elliptic=False, encrypted=False):
        key = ec.generate_private_key(ec.SECP256R1()) if elliptic else rsa.generate_private_key(public_exponent=65537, key_size=2048)
        subject = x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, 'External test document certificate')])
        now = datetime.now(timezone.utc)
        cert = (x509.CertificateBuilder().subject_name(subject).issuer_name(subject).public_key(key.public_key())
                .serial_number(x509.random_serial_number()).not_valid_before(now-timedelta(days=10))
                .not_valid_after(now-timedelta(days=1) if expired else now+timedelta(days=30))
                .add_extension(x509.BasicConstraints(ca=False,path_length=None),True)
                .add_extension(x509.KeyUsage(True,True,False,False,False,False,False,False,False),True).sign(key,hashes.SHA256()))
        password = b'test-only-password' if encrypted else None
        (self.directory/'identity.p12').write_bytes(pkcs12.serialize_key_and_certificates(b'Test',key,cert,None,serialization.BestAvailableEncryption(password) if encrypted else serialization.NoEncryption()))
        (self.directory/'certificate.pem').write_bytes(cert.public_bytes(serialization.Encoding.PEM))
        if encrypted:
            (self.directory/'password').write_bytes(password+b'\n')
        self.fingerprint=e.fingerprint(cert)
        return {'p12File':str(self.directory/'identity.p12'), **({'passwordFile':str(self.directory/'password')} if encrypted else {}), 'expectedFingerprint':self.fingerprint}
    def prepare(self):
        self.manifest={'schema':e.PROFILE,'evidenceSchema':2,'installationId':'test-installation','documentId':'test-document','evidenceDigest':'a'*64,'preparedHash':'b'*64,'checkpoint':{'sequence':3,'hash':'c'*64},'policy':{'timestamp':'off'},'certificateFingerprint':self.fingerprint}
        prepared = asyncio.run(e.prepare({'input':str(self.directory/'input.pdf'),'output':str(self.directory/'prepared.pdf'),'certificateFile':str(self.directory/'certificate.pem'),'manifest':self.manifest}))
        return {**prepared, 'candidateSha256':hashlib.sha256((self.directory/'input.pdf').read_bytes()).hexdigest(), 'candidateLength':(self.directory/'input.pdf').stat().st_size}
    def sign(self, options):
        prepared=self.prepare()
        asyncio.run(e.cms_sign({**prepared,**options,'input':str(self.directory/'prepared.pdf'),'output':str(self.directory/'signed.pdf')}))
        return self.directory/'signed.pdf'
    def test_imported_encrypted_ecdsa_identity(self):
        options=self.key(elliptic=True,encrypted=True)
        signed=self.sign(options)
        result=e.verify({'input':str(signed),'expectedFingerprint':self.fingerprint})
        self.assertEqual(result['integrity'],'valid')
        self.assertEqual(result['issuerTrust'],'pinned')
        with self.assertRaises(Exception):
            e.identity(options['p12File'])
    def test_oversized_public_certificate_chain_is_configuration_failure(self):
        options=self.key()
        key,cert,_,_,_=e.identity(options['p12File'])
        now=datetime.now(timezone.utc)
        huge=(x509.CertificateBuilder().subject_name(cert.subject).issuer_name(cert.issuer).public_key(key.public_key())
              .serial_number(x509.random_serial_number()).not_valid_before(now-timedelta(days=1)).not_valid_after(now+timedelta(days=30))
              .add_extension(x509.UnrecognizedExtension(x509.ObjectIdentifier('1.3.6.1.4.1.55555.1'),b'x'*40000),False).sign(key,hashes.SHA256()))
        with (self.directory/'certificate.pem').open('ab') as target:target.write(huge.public_bytes(serialization.Encoding.PEM))
        with self.assertRaisesRegex(e.SealError,'chain exceeds') as failure:self.prepare()
        self.assertNotIsInstance(failure.exception,e.SealInputError)
    def test_expired_key_cannot_sign(self):
        options=self.key(expired=True)
        self.assertTrue(e.identity(options['p12File'])[4]['notAfter'])
        with self.assertRaisesRegex(ValueError,'not currently valid'):
            self.sign(options)
    def test_nonzero_unsigned_cms_padding_is_rejected(self):
        signed=self.sign(self.key())
        data=bytearray(signed.read_bytes())
        with signed.open('rb') as source:
            sig=PdfFileReader(source).embedded_signatures[0]
            end=sig.byte_range[2]
        data[end-2]=ord('1')
        signed.write_bytes(data)
        with self.assertRaisesRegex(ValueError,'nonzero trailing'):
            e.verify({'input':str(signed)})
    def test_prepared_bytes_modified_before_private_key_worker_fail(self):
        options=self.key()
        prepared=self.prepare()
        data=bytearray((self.directory/'prepared.pdf').read_bytes());data[15]^=1
        (self.directory/'prepared.pdf').write_bytes(data)
        with self.assertRaisesRegex(ValueError,'digest changed|approved candidate'):
            asyncio.run(e.cms_sign({**options,**prepared,'input':str(self.directory/'prepared.pdf'),'output':str(self.directory/'signed.pdf')}))
    def test_key_worker_rejects_wrong_candidate_or_unbounded_incremental_tail(self):
        options=self.key();prepared=self.prepare()
        base={**options,**prepared,'input':str(self.directory/'prepared.pdf'),'output':str(self.directory/'signed.pdf')}
        with self.assertRaisesRegex(ValueError,'approved candidate'):
            asyncio.run(e.cms_sign({**base,'candidateSha256':'a'*64}))
        with (self.directory/'prepared.pdf').open('ab') as output:output.write(b'0' * e.MAX_TAIL)
        with self.assertRaisesRegex(ValueError,'tail budget'):
            asyncio.run(e.cms_sign(base))
    def test_public_prepare_rejects_owner_password_encryption(self):
        self.key()
        w=writer.PdfFileWriter();content=w.add_object(generic.StreamObject(stream_data=b'q Q'))
        w.insert_page(writer.PageObject(content,[0,0,595,842]));w.encrypt('owner-only-test-password',user_pass='')
        with (self.directory/'input.pdf').open('wb') as target:w.write(target)
        with self.assertRaises(ValueError):self.prepare()
    def test_placeholder_overflow_is_not_truncated(self):
        from pyhanko.sign.signers.pdf_byterange import PreparedByteRangeDigest
        from pyhanko.sign.general import SigningError
        with self.assertRaises(SigningError):
            PreparedByteRangeDigest(b'0'*32,1,5).fill_with_cms(io.BytesIO(b' <00> '),b'12345')
    def test_strict_json_rejects_bom_duplicates_invalid_unicode_and_nonfinite(self):
        for value in (b'\xef\xbb\xbf{}',b'{"a":1,"a":2}',b'{"a":"\\ud800"}',b'{"a":NaN}',b'{"a":Infinity}'):
            with self.subTest(value=value),self.assertRaises((ValueError,UnicodeError)):
                e.strict_json(value)
    def test_manifest_approval_receipt_commitments_are_strict(self):
        base={'schema':e.PROFILE,'evidenceSchema':2,'installationId':'i','documentId':'d','evidenceDigest':'a'*64,'preparedHash':'b'*64,'checkpoint':{'sequence':3,'hash':'c'*64},'certificateFingerprint':'d'*64}
        independent={'timestamp':'off','independentApproval':'email'}
        receipt={'recipientId':'r-1','receiptSha256':'e'*64}
        e.check_manifest({**base,'policy':{'timestamp':'off'}})
        e.check_manifest({**base,'policy':independent,'approvalReceipts':[receipt]})
        for manifest in ({**base,'policy':{'timestamp':'off'},'approvalReceipts':[receipt]}, {**base,'policy':independent},
                         {**base,'policy':independent,'approvalReceipts':[]}, {**base,'policy':independent,'approvalReceipts':[receipt,receipt]},
                         {**base,'policy':independent,'approvalReceipts':[{**receipt,'extra':1}]}, {**base,'policy':{'timestamp':'off'},'unknown':1},
                         {**base,'policy':{'timestamp':'off','independentApproval':'passkey'},'approvalReceipts':[receipt]}):
            with self.subTest(manifest=manifest),self.assertRaises(ValueError):
                e.check_manifest(manifest)

if __name__=='__main__':
    unittest.main()
