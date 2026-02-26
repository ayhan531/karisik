import express from 'express';
import bcrypt from 'bcrypt';

const router = express.Router();

const ADMIN_USER = process.env.ADMIN_USER || 'admin';
const ADMIN_PASS_HASH = process.env.ADMIN_PASS_HASH || '$2b$10$I01i/asMuh55MNS.Da5I/OgflUaXsSEwCCOkABSGP2W1O0g6Z8T/C'; // Hash for 'admin123'

router.post('/login', async (req, res) => {
    const { username, password } = req.body;

    if (!username || !password) {
        return res.status(400).json({ success: false, message: 'Kullanıcı adı ve şifre gereklidir.' });
    }

    if (username === ADMIN_USER && await bcrypt.compare(password, ADMIN_PASS_HASH)) {
        req.session.authenticated = true;
        req.session.user = username;
        return res.json({ success: true, message: 'Giriş başarılı.' });
    }

    res.status(401).json({ success: false, message: 'Hatalı kullanıcı adı veya şifre.' });
});

router.post('/logout', (req, res) => {
    req.session.destroy((err) => {
        if (err) {
            return res.status(500).json({ success: false, message: 'Çıkış yapılırken hata oluştu.' });
        }
        res.clearCookie('connect.sid');
        res.json({ success: true, message: 'Başarıyla çıkış yapıldı.' });
    });
});

router.get('/check', (req, res) => {
    if (req.session.authenticated) {
        res.json({ authenticated: true, user: req.session.user });
    } else {
        res.json({ authenticated: false });
    }
});

export default router;
