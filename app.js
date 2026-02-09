const express = require('express');
const mysql = require('mysql2');
const session = require('express-session');

const app = express();

app.use(express.urlencoded({ extended: true }));
app.use(express.static('public'));

app.use(session({
    secret: 'login-secret',
    resave: false,
    saveUninitialized: false
}));

app.set('view engine', 'pug');
app.set('views', './views');

const db = mysql.createConnection({
    host: 'localhost',
    user: 'root',
    password: 'root123',
    database: 'PROYECTO_FINAL',
    port: 3306
});

db.connect(err => {
    if (err) {
        console.error('Error DB:', err);
        return;
    }
    console.log('DB conectada');
});

app.get('/', (req, res) => {
    res.render('login', { error: null, success: null });
});

app.post('/login', (req, res) => {
    const { user_name, password } = req.body;
    const sql = `SELECT * FROM users WHERE user_name = ? AND password = ? AND deleted_at IS NULL`;

    db.query(sql, [user_name, password], (err, results) => {
        if (err) return res.render('login', { error: 'Error del servidor' });

        if (results.length > 0) {
            req.session.user = results[0];
            return res.redirect('/dashboard');
        } else {
            res.render('login', { error: 'Usuario o contraseña incorrectos' });
        }
    });
});

// DASHBOARD - CON ESTADÍSTICAS
// DASHBOARD - CON GRÁFICOS
app.get('/dashboard', (req, res) => {
    if (!req.session.user) return res.redirect('/');

    const sql = `SELECT * FROM vw_analisis_ventas_turnos ORDER BY fecha DESC, hora_inicio DESC`;

    db.query(sql, (err, results) => {
        if (err) return res.render('dashboard', { error: 'Error cargando datos' });

        // --- Procesamiento KPI ---
        const totalVentas = results.reduce((sum, row) => sum + parseFloat(row.total_facturado), 0);
        const turnosAbiertos = results.filter(row => row.estado_turno === 'open').length;
        const mejorTicket = results.reduce((max, row) => Math.max(max, parseFloat(row.ticket_promedio)), 0);

        // --- PREPARAR DATOS PARA GRÁFICOS ---

        // Gráfico 1: Ventas por Cajero (Top Rendimiento)
        // Agrupamos ventas por nombre de cajero
        const ventasPorCajero = {};
        results.forEach(row => {
            if (!ventasPorCajero[row.cajero]) ventasPorCajero[row.cajero] = 0;
            ventasPorCajero[row.cajero] += parseFloat(row.total_facturado);
        });

        // Gráfico 2: Ventas por Día de la Semana
        const ventasPorDia = {};
        results.forEach(row => {
            if (!ventasPorDia[row.dia_semana]) ventasPorDia[row.dia_semana] = 0;
            ventasPorDia[row.dia_semana] += parseFloat(row.total_facturado);
        });

        res.render('dashboard', {
            usuario: req.session.user.user_name,
            listaTurnos: results,
            stats: {
                totalVentas: totalVentas.toFixed(2),
                turnosAbiertos: turnosAbiertos,
                mejorTicket: mejorTicket.toFixed(2),
                totalRegistros: results.length
            },
            // Enviamos los datos listos como string JSON para que Pug los ponga en el script
            chartData: {
                cajerosLabels: JSON.stringify(Object.keys(ventasPorCajero)),
                cajerosValues: JSON.stringify(Object.values(ventasPorCajero)),
                diasLabels: JSON.stringify(Object.keys(ventasPorDia)),
                diasValues: JSON.stringify(Object.values(ventasPorDia))
            }
        });
    });
});
app.get('/logout', (req, res) => {
    req.session.destroy();
    res.redirect('/');
});


// ===== MÓDULO DE VENTAS (FACTURACIÓN) =====

// 1. Mostrar pantalla de productos
app.get('/vender', (req, res) => {
    if (!req.session.user) return res.redirect('/');

    // Traemos los productos activos y con stock
    db.query('SELECT * FROM products WHERE is_active = 1 AND stock > 0', (err, products) => {
        if (err) return res.send("Error al cargar productos");

        res.render('vender', { products });
    });
});

// 2. Procesar la Factura
app.post('/procesar-venta', (req, res) => {
    if (!req.session.user) return res.redirect('/');

    const { customer_name, quantities } = req.body;
    const userId = req.session.user.id;

    // A. PASO 1: VERIFICAR O CREAR UN TURNO (SHIFT) ABIERTO
    const checkShiftSql = `SELECT id FROM shifts WHERE user_id = ? AND status = 'open' LIMIT 1`;

    db.query(checkShiftSql, [userId], (err, results) => {
        if (err) return res.send("Error verificando turno");

        let shiftId;

        const procesarItems = (currentShiftId) => {
            // B. PASO 2: CALCULAR TOTALES Y FILTRAR PRODUCTOS SELECCIONADOS
            // quantities viene como objeto: { '1': '2', '3': '1' } (id: cantidad)

            // Primero necesitamos los precios reales de la BD para evitar hackeos
            db.query('SELECT * FROM products', (err, allProducts) => {
                let totalFactura = 0;
                let itemsToInsert = []; // Array para guardar lo que vamos a insertar

                // Recorremos los productos recibidos
                for (const [prodId, qty] of Object.entries(quantities)) {
                    const cantidad = parseInt(qty);
                    if (cantidad > 0) {
                        const productoReal = allProducts.find(p => p.id == prodId);
                        if (productoReal) {
                            const subtotal = productoReal.price * cantidad;
                            totalFactura += subtotal;
                            itemsToInsert.push({
                                product_id: prodId,
                                quantity: cantidad,
                                price: productoReal.price,
                                subtotal: subtotal
                            });
                        }
                    }
                }

                if (itemsToInsert.length === 0) return res.redirect('/vender'); // No seleccionó nada

                // C. PASO 3: CREAR LA FACTURA (INVOICE)
                const sqlInvoice = `INSERT INTO invoices (shift_id, customer_name, total) VALUES (?, ?, ?)`;

                db.query(sqlInvoice, [currentShiftId, customer_name, totalFactura], (err, resultInvoice) => {
                    if (err) { console.log(err); return res.send("Error creando factura"); }

                    const invoiceId = resultInvoice.insertId;

                    // D. PASO 4: INSERTAR LOS ITEMS Y RESTAR STOCK
                    // Hacemos un loop simple (en prod real se usa bulk insert, pero esto funciona bien)
                    itemsToInsert.forEach(item => {
                        // Insertar item
                        db.query(`INSERT INTO invoice_items (invoice_id, product_id, quantity, price_at_moment, subtotal) VALUES (?, ?, ?, ?, ?)`,
                            [invoiceId, item.product_id, item.quantity, item.price, item.subtotal]);

                        // Restar Stock
                        db.query(`UPDATE products SET stock = stock - ? WHERE id = ?`,
                            [item.quantity, item.product_id]);
                    });

                    // ¡LISTO! VOLVEMOS AL DASHBOARD
                    res.redirect('/dashboard');
                });
            });
        };

        // Lógica del turno (continuación del Paso A)
        if (results.length > 0) {
            // Ya hay turno abierto, úsalo
            shiftId = results[0].id;
            procesarItems(shiftId);
        } else {
            // No hay turno, creamos uno automático
            db.query(`INSERT INTO shifts (user_id, start_time, status) VALUES (?, NOW(), 'open')`, [userId], (err, resShift) => {
                if (err) return res.send("Error abriendo turno");
                shiftId = resShift.insertId;
                procesarItems(shiftId);
            });
        }
    });
});
app.get('/forgot-password', (req, res) => {
    res.render('forgot', { error: null });
});

app.post('/forgot-password', (req, res) => {
    const { user_name } = req.body;

    db.query('SELECT * FROM users WHERE user_name = ? AND deleted_at IS NULL', [user_name], (err, results) => {
        if (err) return res.render('forgot', { error: 'Error de base de datos' });

        if (results.length === 0) {
            return res.render('forgot', { error: 'Usuario no encontrado' });
        }

        const user = results[0];
        const token = Math.floor(1000 + Math.random() * 9000).toString();
        const expiresAt = new Date(Date.now() + 3600000).toISOString().slice(0, 19).replace('T', ' ');

        const sqlReset = `INSERT INTO password_resets (user_id, token_hash, expires_at) VALUES (?, ?, ?)`;

        db.query(sqlReset, [user.id, token, expiresAt], (err) => {
            if (err) return res.render('forgot', { error: 'No se pudo generar el token' });

            res.render('reset_simulation', {
                user_name: user.user_name,
                user_id: user.id,
                token: token,
                error: null
            });
        });
    });
});

app.post('/reset-password', (req, res) => {
    const { user_id, token, new_password } = req.body;

    const sqlCheck = `SELECT * FROM password_resets WHERE user_id = ? AND token_hash = ? AND is_used = 0 AND expires_at > NOW() ORDER BY created_at DESC LIMIT 1`;

    db.query(sqlCheck, [user_id, token], (err, results) => {
        if (err || results.length === 0) {
            return res.render('reset_simulation', {
                user_id,
                token: token,
                user_name: 'Usuario',
                error: 'Código inválido o expirado'
            });
        }

        const resetId = results[0].id;

        db.query('UPDATE users SET password = ? WHERE id = ?', [new_password, user_id], (err) => {
            if (err) return res.send("Error al actualizar contraseña");

            db.query('UPDATE password_resets SET is_used = 1 WHERE id = ?', [resetId], () => {
                res.render('login', { success: 'Contraseña actualizada correctamente. Inicia sesión.', error: null });
            });
        });
    });
});

app.listen(3000, () => {
    console.log('Servidor corriendo en http://localhost:3000');
});