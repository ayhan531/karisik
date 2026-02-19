import bcrypt from 'bcrypt';

const password = process.argv[2];

if (!password) {
    console.log('Lütfen şifre girin: node scripts/hash_password.js <sifre>');
    process.exit(1);
}

const saltRounds = 10;
const hash = await bcrypt.hash(password, saltRounds);

console.log('--- ŞİFRE HASH ---');
console.log(hash);
console.log('------------------');
console.log('Bu hash değerini ADMIN_PASS_HASH ortam değişkenine kaydedin.');
