const express = require('express');
const mysql = require('mysql2');
const session = require('express-session');

const app = express();

// ===== MIDDLEWARE =====

app.use(express.urlencoded({ extended: true }));
app.use(express.static('public'));

app.use(session({
    secret: 'login-secret',
    resave: false,
    saveUninitialized: false
}));

app.set('view engine', 'pug');
app.set('views', './views');

// ===== DATABASE =====

const db = mysql.createConnection({
    host: 'localhost',
    user: 'root',
    password: 'root123',
    database: 'PROYECTO_FINAL',
    port: 3306
});

db.connect(err => {
    if (err) {
        console.error('❌ Error DB:', err);
        return;
    }
    console.log('✅ DB conectada');
});

// ===== ROUTES =====

// LOGIN PAGE
app.get('/', (req, res) => {
    res.render('login', { error: null });
});

// LOGIN PROCESS
app.post('/login', (req, res) => {

    const { user_name, password } = req.body;

    const sql = `
        SELECT * FROM users
        WHERE user_name = ?
        AND password = ?
        AND deleted_at IS NULL
    `;

    db.query(sql, [user_name, password], (err, results) => {

        if (err) {
            console.error(err);
            return res.render('login', { error: 'Error del servidor' });
        }

        if (results.length > 0) {

            req.session.user = results[0];

            return res.redirect('/dashboard');

        } else {

            res.render('login', {
                error: 'Usuario o contraseña incorrectos'
            });
        }

    });
});

// DASHBOARD
app.get('/dashboard', (req, res) => {

    if (!req.session.user) {
        return res.redirect('/');
    }

    const productos = [
        { name: 'Empanada Carne', price: 1.50 },
        { name: 'Empanada Queso', price: 1.25 },
        { name: 'Coca Cola', price: 1.00 },
        { name: 'Empanada Mixta', price: 1.75 }
    ];

    res.render('dashboard', {
        usuario: req.session.user.user_name,
        productos
    });

});

// LOGOUT
app.get('/logout', (req, res) => {
    req.session.destroy();
    res.redirect('/');
});

// ===== SERVER =====

app.listen(3000, () => {
    console.log('🚀 Servidor → http://localhost:3000');
});