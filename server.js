// --- COMIENZO DE server.js ---
const express = require('express');
const bodyParser = require('body-parser');
const { Client } = require('pg');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const session = require('express-session');
// AGREGAR ESTA LÍNEA PARA CARGAR LAS VARIABLES DE ENTORNO
require('dotenv').config(); 

const app = express();
// CAMBIAR: Usar la variable de entorno PORT (que asigna el hosting)

// --- server.js (Bloque de Conexión COMPLETO) ---

// 1. BASE DE DATOS (REEMPLAZA TODO EL BLOQUE DE client = new Client)
const client = new Client({
  // PRIORIDAD 1: Usa la URL completa que Render crea automáticamente.
  connectionString: process.env.DATABASE_URL, 
  
  // FALLBACKS (Si DATABASE_URL no existe o para desarrollo local):
  user: process.env.DB_USER || 'postgres',
  host: process.env.DB_HOST || 'localhost',
  database: process.env.DB_NAME || 'hospital_nefrologia',
  password: process.env.DB_PASSWORD, 
  port: process.env.DB_PORT || 5432,
  
  // CONDICIÓN SSL (Solo activa SSL si DATABASE_URL existe)
  ssl: process.env.DATABASE_URL ? { 
    rejectUnauthorized: false 
  } : false 
}); 
// ^^^^^ ESTE SÍ ES EL CIERRE CORRECTO.


client.connect()
  .then(() => console.log('✅ Conexión exitosa a PostgreSQL')) // <--- Línea 28
  .catch(err => console.error('❌ Error de conexión a BD', err.stack));
// 2. CONFIGURACIÓN DE SESIÓN
app.use(session({
    secret: 'secreto_super_seguro_hgc',
    resave: false,
    saveUninitialized: false
}));

// 3. MULTER (ARCHIVOS)
const uploadDir = './public/uploads';
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });

const storage = multer.diskStorage({
    destination: (req, file, cb) => cb(null, 'public/uploads/'),
    filename: (req, file, cb) => cb(null, Date.now() + path.extname(file.originalname))
});
const upload = multer({ storage: storage });

// 4. MIDDLEWARE
app.use(bodyParser.urlencoded({ extended: true }));
app.use(bodyParser.json());
app.use(express.static('public'));

// --- RUTAS DE AUTENTICACIÓN ---

app.post('/login', async (req, res) => {
    const { email, password } = req.body;
    try {
        const result = await client.query('SELECT * FROM usuarios WHERE email = $1 AND password = $2', [email, password]);
        if (result.rows.length > 0) {
            const user = result.rows[0];
            
            req.session.userId = user.id;
            req.session.rolId = user.rol_id;
            req.session.nombre = user.nombre_completo;

            if(user.rol_id === 1) res.redirect('/admin.html');
            else if(user.rol_id === 2) res.redirect('/doctor.html');
            else res.redirect('/paciente.html');
        } else {
            res.send('<script>alert("Credenciales incorrectas"); window.location.href="/login.html";</script>');
        }
    } catch (err) { res.status(500).send("Error servidor"); }
});

app.get('/logout', (req, res) => {
    req.session.destroy();
    res.redirect('/index.html');
});

// --- RUTAS API DEL PACIENTE ---

// 1. Obtener Perfil
// --- EN SERVER.JS ---
app.get('/api/mi-perfil', async (req, res) => {
    if (!req.session.userId) return res.status(401).json({ error: 'No autorizado' });
    try {
        // CAMBIO CRUCIAL: Cambiamos 'u.cedula' por 'p.cedula'
        const query = `
            SELECT u.nombre_completo, u.email, 
                   p.cedula, p.telefono, p.contacto_emergencia, p.estadio_erc, p.direccion,
                   p.urea, p.creatinina 
            FROM usuarios u
            JOIN pacientes p ON u.id = p.usuario_id
            WHERE u.id = $1
        `;
        const result = await client.query(query, [req.session.userId]);
        if(result.rows.length > 0) res.json(result.rows[0]);
        else res.status(404).json({error: 'Perfil no encontrado'});
    } catch (err) { res.status(500).json({ error: 'Error servidor' }); }
});
// 2. Actualizar Contactos
app.put('/api/actualizar-mis-contactos', async (req, res) => {
    if (!req.session.userId) return res.status(401).json({ error: 'No autorizado' });
    const { telefono, emergencia } = req.body;
    try {
        await client.query('UPDATE pacientes SET telefono = $1, contacto_emergencia = $2 WHERE usuario_id = $3', [telefono, emergencia, req.session.userId]);
        res.json({ success: true });
    } catch (err) { res.status(500).json({ error: 'Error' }); }
});

// 3. Lista de Doctores (Con Cargo)
app.get('/api/lista-doctores', async (req, res) => {
    try {
        const result = await client.query("SELECT id, nombre_completo, cargo FROM usuarios WHERE rol_id = 2");
        res.json(result.rows);
    } catch (err) { res.status(500).json({ error: 'Error' }); }
});

// 4. Pedir Cita (CORREGIDO: paciente_id en singular)
app.post('/api/pedir-cita', async (req, res) => {
    if (!req.session.userId) return res.status(401).json({ error: 'No autorizado' });
    const { doctor_id, fecha, hora, motivo } = req.body;
    const fechaHora = `${fecha} ${hora}:00`;

    try {
        const pRes = await client.query('SELECT id FROM pacientes WHERE usuario_id = $1', [req.session.userId]);
        if(pRes.rows.length === 0) return res.status(400).json({error: 'Paciente no encontrado'});
        
        // CORREGIDO AQUI: paciente_id (singular)
        await client.query(
            'INSERT INTO citas (paciente_id, medico_id, fecha_hora, motivo, estado) VALUES ($1, $2, $3, $4, $5)',
            [pRes.rows[0].id, doctor_id, fechaHora, motivo, 'Pendiente']
        );
        res.json({ success: true });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// 5. Mis Citas (CORREGIDO: paciente_id en singular)
app.get('/api/mis-citas', async (req, res) => {
    if (!req.session.userId) return res.status(401).json({ error: 'No autorizado' });
    try {
        // CORREGIDO AQUI: c.paciente_id (singular)
        const query = `
            SELECT c.fecha_hora, c.motivo, c.estado, u.nombre_completo as doctor
            FROM citas c
            JOIN pacientes p ON c.paciente_id = p.id  
            JOIN usuarios u ON c.medico_id = u.id      
            WHERE p.usuario_id = $1
            ORDER BY c.fecha_hora DESC
        `;
        const result = await client.query(query, [req.session.userId]);
        res.json(result.rows);
    } catch (err) { 
        console.error(err); 
        res.status(500).json({ error: 'Error servidor' }); 
    }
});

// 6. Mis Archivos
app.get('/api/mis-archivos', async (req, res) => {
    if (!req.session.userId) return res.status(401).json({ error: 'No autorizado' });
    try {
        const pRes = await client.query('SELECT id FROM pacientes WHERE usuario_id = $1', [req.session.userId]);
        if(pRes.rows.length === 0) return res.json([]);
        
        const result = await client.query('SELECT * FROM archivos_pacientes WHERE paciente_id = $1 ORDER BY fecha_envio DESC', [pRes.rows[0].id]);
        res.json(result.rows);
    } catch (err) { res.status(500).json({ error: 'Error' }); }
});

// --- RUTAS ADMINISTRATIVAS ---

app.get('/api/pacientes-lista', async (req, res) => {
    try {
        const result = await client.query('SELECT p.*, u.nombre_completo, u.email FROM pacientes p JOIN usuarios u ON p.usuario_id = u.id ORDER BY p.id DESC');
        res.json(result.rows);
    } catch (err) { res.status(500).json({error:'Error'}); }
});
app.get('/api/personal-lista', async (req, res) => {
    try { const result = await client.query("SELECT * FROM usuarios WHERE rol_id = 2 ORDER BY id DESC"); res.json(result.rows); } catch (err) { res.status(500).json({error:'Error'}); }
});
app.get('/api/inventario-lista', async (req, res) => {
    try { const result = await client.query("SELECT * FROM equipos ORDER BY id DESC"); res.json(result.rows); } catch (err) { res.status(500).json({error:'Error'}); }
});

// REGISTROS ADMIN
app.post('/register-patient', async (req, res) => {
    const { nombre, cedula, email, password, fecha_nacimiento, sexo, telefono, direccion, contacto_emergencia, urea, creatinina, estadio, comorbilidades } = req.body;
    try {
        await client.query('BEGIN');
        const userRes = await client.query('INSERT INTO usuarios (nombre_completo, email, password, rol_id) VALUES ($1, $2, $3, 3) RETURNING id', [nombre, email, password]);
        const uid = userRes.rows[0].id;
        const fecha = (fecha_nacimiento === '') ? null : fecha_nacimiento;
        await client.query(
            `INSERT INTO pacientes (usuario_id, cedula, fecha_nacimiento, sexo, telefono, direccion, contacto_emergencia, urea, creatinina, estadio_erc, comorbilidades) 
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
            [uid, cedula, fecha, sexo, telefono, direccion, contacto_emergencia, urea, creatinina, estadio, comorbilidades]
        );
        await client.query('COMMIT');
        res.json({ success: true });
    } catch (err) { await client.query('ROLLBACK'); res.status(500).json({ error: err.message }); }
});

app.post('/register-staff', async (req, res) => {
    const { nombre, cedula, fecha_nacimiento, telefono, email, password, cargo, horario } = req.body;
    try {
        const passFinal = password ? password : "NO_ACCESO"; 
        const fecha = (fecha_nacimiento === '') ? null : fecha_nacimiento;
        await client.query(`INSERT INTO usuarios (nombre_completo, cedula, fecha_nacimiento, telefono, email, password, cargo, horario, rol_id) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 2)`, [nombre, cedula, fecha, telefono, email, passFinal, cargo, horario]);
        res.json({ success: true });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/register-equipment', async (req, res) => {
    const { nombre, serial, ubicacion, estado } = req.body;
    try {
        await client.query('INSERT INTO equipos (nombre, serial, ubicacion, estado, fecha_adquisicion) VALUES ($1, $2, $3, $4, CURRENT_DATE)', [nombre, serial, ubicacion, estado]);
        res.json({ success: true });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// Enviar Receta (Admin)
// En server.js (Busca esta parte y modifícala)
app.post('/api/enviar-receta', upload.single('archivo'), async (req, res) => {
    const { paciente_id, descripcion, tipo } = req.body;
    const archivo = req.file ? '/uploads/' + req.file.filename : null;
    const nombreOrg = req.file ? req.file.originalname : 'Sin archivo';
    
    try {
        await client.query(
            'INSERT INTO archivos_pacientes (paciente_id, nombre_archivo, ruta_archivo, tipo_archivo, descripcion) VALUES ($1, $2, $3, $4, $5)',
            [paciente_id, nombreOrg, archivo, tipo, descripcion]
        );
        
        // CAMBIO AQUÍ: En lugar de res.redirect('/admin.html');
        res.json({ success: true }); // Devolvemos JSON para que el frontend lo maneje
        
    } catch (err) { 
        console.error(err);
        res.status(500).json({ success: false, error: "Error al subir archivo" }); 
    }
});
app.put('/api/paciente/:id', async (req, res) => {
    const { id } = req.params;
    const { nombre, email, cedula, fecha_nacimiento, sexo, telefono, direccion, emergencia, urea, creatinina, estadio, comorbilidades } = req.body;
    try {
        await client.query('BEGIN');
        await client.query(`UPDATE usuarios SET nombre_completo = $1, email = $2 WHERE id = (SELECT usuario_id FROM pacientes WHERE id = $3)`, [nombre, email, id]);
        await client.query(`UPDATE pacientes SET cedula=$1, fecha_nacimiento=$2, sexo=$3, telefono=$4, direccion=$5, contacto_emergencia=$6, urea=$7, creatinina=$8, estadio_erc=$9, comorbilidades=$10 WHERE id=$11`, [cedula, fecha_nacimiento, sexo, telefono, direccion, emergencia, urea, creatinina, estadio, comorbilidades, id]);
        await client.query('COMMIT');
        res.json({ success: true });
    } catch (err) { await client.query('ROLLBACK'); res.status(500).json({ error: 'Error' }); }
});

app.put('/api/personal/:id', async (req, res) => {
    const { id } = req.params;
    const { nombre, email, cargo, horario, telefono, cedula, fecha_nacimiento } = req.body;
    try {
        await client.query('UPDATE usuarios SET nombre_completo=$1, email=$2, cargo=$3, horario=$4, telefono=$5, cedula=$6, fecha_nacimiento=$7 WHERE id=$8', [nombre, email, cargo, horario, telefono, cedula, fecha_nacimiento, id]);
        res.json({ success: true });
    } catch (err) { res.status(500).json({ error: 'Error' }); }
});

app.put('/api/inventario/:id', async (req, res) => {
    const { nombre, serial, ubicacion, estado } = req.body;
    try { await client.query('UPDATE equipos SET nombre=$1, serial=$2, ubicacion=$3, estado=$4 WHERE id=$5', [nombre, serial, ubicacion, estado, req.params.id]); res.json({ success: true }); } catch (err) { res.status(500).json({ error: 'Error' }); }
});

// --- server.js ---

app.delete('/api/personal/:id', async (req, res) => {
    const id = req.params.id; // ID del usuario/personal a borrar
    try {
        await client.query('BEGIN'); // Inicia una transacción

        // 1. ELIMINAR CITAS: Eliminar todas las citas asociadas a este médico
        await client.query('DELETE FROM citas WHERE medico_id = $1', [id]);

        // 2. ELIMINAR USUARIO: Ahora puedes borrar al usuario de la tabla principal
        await client.query('DELETE FROM usuarios WHERE id = $1', [id]);

        await client.query('COMMIT'); // Confirma la transacción
        
        res.json({ success: true });
    } catch (err) { 
        await client.query('ROLLBACK'); // Si algo falla, revierte
        console.error("Error al borrar personal:", err);
        res.status(500).json({ error: 'Error al borrar personal. Verifique dependencias.' }); 
    }
});
app.delete('/api/personal/:id', async (req, res) => { try { await client.query('DELETE FROM usuarios WHERE id=$1', [req.params.id]); res.json({success:true}); } catch (err) { res.status(500).json({error:'Error'}); } });
app.delete('/api/inventario/:id', async (req, res) => { try { await client.query('DELETE FROM equipos WHERE id=$1', [req.params.id]); res.json({success:true}); } catch (err) { res.status(500).json({error:'Error'}); } });

app.get('/api/historial-archivos', async (req, res) => {
    try {
        const query = `SELECT a.*, u.nombre_completo as paciente_nombre FROM archivos_pacientes a JOIN pacientes p ON a.paciente_id = p.id JOIN usuarios u ON p.usuario_id = u.id ORDER BY a.fecha_envio DESC`;
        const result = await client.query(query);
        res.json(result.rows);
    } catch (err) { res.status(500).json({error: 'Error'}); }
});

app.put('/api/cambiar-password', async (req, res) => {
    const { email, passwordActual, passwordNueva } = req.body;
    try {
        const result = await client.query('SELECT * FROM usuarios WHERE email = $1 AND password = $2', [email, passwordActual]);
        if (result.rows.length > 0) {
            await client.query('UPDATE usuarios SET password = $1 WHERE email = $2', [passwordNueva, email]);
            res.json({ success: true });
        } else {
            res.json({ success: false, error: 'Credenciales incorrectas' });
        }
    } catch (err) { res.status(500).json({ error: 'Error' }); }
});


// --- API DOCTOR ---

// --- AGREGAR ESTO EN LA SECCIÓN API DOCTOR ---

// 4. Obtener Perfil del Doctor Logueado
app.get('/api/doctor/mi-perfil', async (req, res) => {
    if (!req.session.userId) return res.status(401).json({ error: 'No autorizado' });
    try {
        // Buscamos los datos directos de la tabla usuarios
        const result = await client.query(
            'SELECT nombre_completo, email, cedula, telefono, cargo, horario FROM usuarios WHERE id = $1', 
            [req.session.userId]
        );
        
        if (result.rows.length > 0) {
            res.json(result.rows[0]);
        } else {
            res.status(404).json({ error: 'Usuario no encontrado' });
        }
    } catch (err) { res.status(500).json({ error: 'Error de servidor' }); }
});

// 3. Actualizar Historia Clínica (INCLUYE LOS NUEVOS DATOS EXTENSOS)
app.put('/api/doctor/actualizar-clinica/:id', async (req, res) => {
    // Ahora recibimos 'historia_completa' que es un objeto JSON con vacunas, cirugias, etc.
    const { urea, creatinina, estadio, comorbilidades, historia_completa } = req.body;
    try {
        await client.query(
            'UPDATE pacientes SET urea=$1, creatinina=$2, estadio_erc=$3, comorbilidades=$4, historia_completa=$5 WHERE id=$6',
            [urea, creatinina, estadio, comorbilidades, JSON.stringify(historia_completa), req.params.id]
        );
        res.json({ success: true });
    } catch (err) { 
        console.error(err);
        res.status(500).json({ error: 'Error actualizando historia' }); 
    }
});







// ==========================================
// API DOCTOR (CORREGIDA SEGÚN TU BASE DE DATOS)
// ==========================================

// 1. Obtener Citas del Doctor
app.get('/api/doctor/mis-citas', async (req, res) => {
    if (!req.session.userId) return res.status(401).json({ error: 'No autorizado' });
    try {
        // CORRECCIÓN: Usamos 'medico_id' y 'paciente_id' (singular)
        const query = `
            SELECT c.id, c.fecha_hora, c.motivo, c.estado, 
                   u.nombre_completo as paciente, p.cedula, 
                   p.id as paciente_real_id
            FROM citas c
            JOIN pacientes p ON c.paciente_id = p.id  
            JOIN usuarios u ON p.usuario_id = u.id
            WHERE c.medico_id = $1
            ORDER BY c.fecha_hora ASC
        `;
        const result = await client.query(query, [req.session.userId]);
        res.json(result.rows);
    } catch (err) { 
        console.error(err);
        res.status(500).json({ error: 'Error obteniendo citas doctor' }); 
    }
});

// 2. Cambiar Estado de Cita (Aprobar/Rechazar)
app.put('/api/cita-estado/:id', async (req, res) => {
    const { estado } = req.body;
    try {
        await client.query('UPDATE citas SET estado = $1 WHERE id = $2', [estado, req.params.id]);
        res.json({ success: true });
    } catch (err) { res.status(500).json({ error: 'Error actualizando cita' }); }
});

// 3. Actualizar Historia Clínica (Sistema Experto)
app.put('/api/doctor/actualizar-clinica/:id', async (req, res) => {
    const { urea, creatinina, estadio, comorbilidades } = req.body;
    try {
        await client.query(
            'UPDATE pacientes SET urea=$1, creatinina=$2, estadio_erc=$3, comorbilidades=$4 WHERE id=$5',
            [urea, creatinina, estadio, comorbilidades, req.params.id]
        );
        res.json({ success: true });
    } catch (err) { res.status(500).json({ error: 'Error actualizando historia' }); }
});




































// 7. INICIAR SERVIDOR (Lee el puerto del entorno o usa 3000 por defecto)
const PORT = process.env.PORT || 3000; 

app.listen(PORT, () => {
  console.log(`🚀 Servidor SINEF corriendo en http://localhost:${PORT}`);

});

