const express = require('express');
const router = express.Router();

router.get('/', (req, res) => {
    res.render('login', { error: null });
});

router.post('/login', (req, res) => {

    const { user_name, password } = req.body;

    const sql = `
        SELECT * FROM users
        WHERE user_name = ?
        AND password = ?
        AND deleted_at IS NULL
    `;

    req.db.query(sql, [user_name, password], (err, result) => {

        if (err) throw err;

        if (result.length > 0) {
            req.session.user = result[0];
            return res.redirect('/dashboard');
        }

        res.render('login', { error: 'Credenciales incorrectas' });
    });
});

router.get('/dashboard', (req, res) => {

    if (!req.session.user)
        return res.redirect('/');

    res.render('dashboard', {
        usuario: req.session.user.user_name
    });
});

module.exports = router;