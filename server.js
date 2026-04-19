// Load environment variables from .env file
require('dotenv').config();

const express = require('express');
const http = require('http');
const path = require('path');
const { Server } = require('socket.io');
const bcrypt = require('bcryptjs');
const db = require('./db'); // Import the DB connection 
const session = require('express-session');
const PgSession = require('connect-pg-simple')(session);
const multer = require('multer');
const PDFDocument = require('pdfkit');
const fs = require('fs');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

// --- SETTINGS ---
// Set EJS as the template engine to render our HTML
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

// Serve static files (CSS, Images, JS) from the 'public' folder
app.use(express.static(path.join(__dirname, 'public')));

// Middleware to parse form data (needed for Login/Signup)
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

// Attach io to every request so routes can emit real-time events.
app.use((req, res, next) => {
    req.io = io;
    next();
});

// --- SESSION SETUP ---
// 1. Define the session middleware separately so we can share it
const sessionMiddleware = session({
    store: new PgSession({
        conObject: {
            user: process.env.DB_USER,
            host: process.env.DB_HOST,
            database: process.env.DB_NAME,
            password: process.env.DB_PASSWORD,
            port: process.env.DB_PORT,
        },
        tableName: 'user_sessions',
        createTableIfMissing: true,
    }),
    secret: 'mycarrepair_secret_key_2026',
    resave: false,
    saveUninitialized: false,
    cookie: {
        secure: false,
        maxAge: 1000 * 60 * 60 * 24 * 14,
    }
});

// 2. Tell Express to use it
app.use(sessionMiddleware);

// 3. Tell Socket.io to use it (This fixes your crash!)
io.engine.use(sessionMiddleware);

// --- MULTER FILE UPLOAD CONFIGURATION ---
// Configure how files are stored
const storage = multer.diskStorage({
    destination: (req, file, cb) => {
        // Determine destination based on field name
        if (file.fieldname === 'part_photos' || file.fieldname === 'part_photo') {
            cb(null, 'public/uploads/parts/');
        } else {
            cb(null, 'public/uploads/cars/');
        }
    },
    filename: (req, file, cb) => {
        // Create a unique filename based on type
        const prefix = (file.fieldname === 'part_photos' || file.fieldname === 'part_photo') ? 'part-' : 'car-';
        cb(null, prefix + Date.now() + path.extname(file.originalname));
    }
});

const upload = multer({ storage: storage });

// Ensure booking decline status exists in Postgres enum values.
async function ensureJobStatusEnumValues() {
    try {
        const enumCheck = await db.query(`
            SELECT 1
            FROM pg_enum e
            JOIN pg_type t ON t.oid = e.enumtypid
            WHERE t.typname = 'job_status' AND e.enumlabel = 'cancelled'
            LIMIT 1
        `);

        if (enumCheck.rows.length === 0) {
            await db.query("ALTER TYPE job_status ADD VALUE 'cancelled'");
        }

        console.log('job_status enum checked: cancelled value available.');
    } catch (err) {
        console.error('Enum migration warning (job_status.cancelled):', err.message);
    }
}

ensureJobStatusEnumValues();

// --- HELPER FUNCTION TO BROADCAST JOBS ---
async function broadcastJob(jobId) {
    const query = `
        SELECT j.*, u.full_name as owner_name, v.make, v.model, v.plate_number 
        FROM jobs j
        JOIN users u ON j.owner_id = u.id
        JOIN vehicles v ON j.vehicle_id = v.id
        WHERE j.id = $1
    `;
    const result = await db.query(query, [jobId]);
    // Only broadcast to online mechanics in the 'online_mechanics' room
    io.to('online_mechanics').emit('new_job_pushed', result.rows[0]);
}

// HELPER: Generate a 4-digit verification code
// const generateCode = () => Math.floor(1000 + Math.random() * 9000).toString();

// HELPER: Group jobs by human-friendly dates
function groupJobsByDate(jobs) {
    const groups = { Today: [], Yesterday: [], 'This Week': [], 'Last Week': [], 'Last Month': [], Older: [] };
    const now = new Date();
    
    jobs.forEach(job => {
        const date = new Date(job.created_at);
        const diffDays = Math.floor((now - date) / (1000 * 60 * 60 * 24));

        if (diffDays === 0) groups.Today.push(job);
        else if (diffDays === 1) groups.Yesterday.push(job);
        else if (diffDays < 7) groups['This Week'].push(job);
        else if (diffDays < 14) groups['Last Week'].push(job);
        else if (diffDays < 30) groups['Last Month'].push(job);
        else groups.Older.push(job);
    });
    return groups;
}

function isPastScheduledDate(dateValue) {
    if (!dateValue || dateValue === 'Immediate') return false;
    const parsed = new Date(dateValue);
    if (Number.isNaN(parsed.getTime())) return false;
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    parsed.setHours(0, 0, 0, 0);
    return parsed < today;
}

// --- ROUTES ---
// Landing Page Route
app.get('/', (req, res) => {
    res.render('index'); // This will look for views/index.ejs
});

// Login Page Route
app.get('/login', (req, res) => {
    res.render('login'); // This will look for views/login.ejs
});

// Route to show Signup Page
app.get('/signup', (req, res) => {
    res.render('signup');
});

// Admin Contact Page Route
app.get('/admin-contact', (req, res) => {
    res.render('admin-contact');
});

// POST Route to handle Signup Logic
app.post('/auth/signup', async (req, res) => {
    const { full_name, email, phone, password, role } = req.body;

    try {
        // 1. Check if user already exists
        const userExists = await db.query('SELECT * FROM users WHERE email = $1', [email]);
        if (userExists.rows.length > 0) {
            return res.send("User already exists with this email.");
        }

        // 2. Hash the password for security
        const salt = await bcrypt.genSalt(10);
        const hashedPassword = await bcrypt.hash(password, salt);

        // 3. Insert into PostgreSQL
        const newUser = await db.query(
            'INSERT INTO users (full_name, email, phone, password, role) VALUES ($1, $2, $3, $4, $5) RETURNING id',
            [full_name, email, phone, hashedPassword, role]
        );

        console.log("New User Created ID:", newUser.rows[0].id);
        
        // 4. Redirect to login page after successful registration
        res.redirect('/login');

    } catch (err) {
        console.error(err.message);
        res.status(500).send("Server Error during registration");
    }
});

// --- LOGIN LOGIC ---
app.post('/auth/login', async (req, res) => {
    const { email, password, role } = req.body;

    try {
        const result = await db.query('SELECT * FROM users WHERE email = $1 AND role = $2', [email, role]);
        
        if (result.rows.length === 0) {
            return res.send("Invalid email or role selection.");
        }

        const user = result.rows[0];

        // Compare hashed password
        const isMatch = await bcrypt.compare(password, user.password);
        if (!isMatch) {
            return res.send("Incorrect password.");
        }

        // Save user info in the session
        req.session.userId = user.id;
        req.session.userName = user.full_name;
        req.session.role = user.role;

        // Redirect based on role
        if (user.role === 'owner') {
            res.redirect('/owner/dashboard');
        } else {
            res.redirect('/mechanic/dashboard');
        }

    } catch (err) {
        console.error(err);
        res.status(500).send("Login error");
    }
});

// Middleware to protect routes (ensure only logged in users see dashboards)
const isAuthenticated = (req, res, next) => {
    if (req.session.userId) return next();
    res.redirect('/login');
};

// Route to show Add Car page
app.get('/owner/add-car', isAuthenticated, (req, res) => {
    res.render('owner/add-car', {
        userId: req.session.userId
    });
});

// POST: Add Car with Professional Fix
app.post('/owner/add-car', isAuthenticated, upload.array('car_photos', 5), async (req, res) => {
    // 1. Capture all 11 fields from the form
    const { 
        make, model, year, plate, fuel_type, 
        last_service, transmission, tyre_size, color, mileage 
    } = req.body;
    
    // 2. Handle photos
    const photoPaths = req.files ? req.files.map(file => '/uploads/cars/' + file.filename).join(',') : '';

    try {
        // 3. Insert into DB (Ensure columns match your table exactly)
        await db.query(
            `INSERT INTO vehicles (
                owner_id, make, model, year, plate_number, fuel_type, 
                last_service_date, transmission, tyre_size, color, mileage, photos
            ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
            [
                req.session.userId, make, model, year, plate, fuel_type, 
                last_service || null, transmission, tyre_size, color, mileage || 0, photoPaths
            ]
        );
        res.redirect('/owner/dashboard');
    } catch (err) {
        console.error(err);
        res.status(500).send("Error saving vehicle");
    }
});

// Update the Dashboard to fetch REAL cars
app.get('/owner/dashboard', isAuthenticated, async (req, res) => {
    try {
        const vehicles = await db.query('SELECT * FROM vehicles WHERE owner_id = $1', [req.session.userId]);
        const activeJob = await db.query('SELECT * FROM jobs WHERE owner_id = $1 AND status != $2 LIMIT 1', [req.session.userId, 'completed']);
        const pendingRatingJob = await db.query(`
            SELECT j.id
            FROM jobs j
            LEFT JOIN reviews r ON r.job_id = j.id
            WHERE j.owner_id = $1
              AND j.status = 'completed'
              AND r.id IS NULL
            ORDER BY j.updated_at DESC, j.created_at DESC
            LIMIT 1
        `, [req.session.userId]);
        
        res.render('owner/dashboard', { 
            userName: req.session.userName, 
            userId: req.session.userId, // <--- ADD THIS LINE
            cars: vehicles.rows,
            activeJob: activeJob.rows[0],
            pendingRatingJobId: pendingRatingJob.rows[0] ? pendingRatingJob.rows[0].id : null
        });
    } catch (err) { console.error(err); res.send("Error loading dashboard"); }
});

// GET: View Car Details
app.get('/owner/car/:id', isAuthenticated, async (req, res) => {
    const carId = req.params.id;
    try {
        const carResult = await db.query('SELECT * FROM vehicles WHERE id = $1', [carId]);
        if (carResult.rows.length === 0) {
            return res.status(404).send("Car not found");
        }
        // Pass userName from session to template
        res.render('owner/car-details', {
            car: carResult.rows[0],
            userName: req.session.userName,
            userId: req.session.userId
        });
    } catch (err) {
        console.error(err);
        res.status(500).send("Error loading car details");
    }
});

// GET: Show Profile Page
app.get('/owner/profile', isAuthenticated, async (req, res) => {
    try {
        const userId = req.session.userId;

        // 1. Fetch User Details
        const userResult = await db.query('SELECT full_name, email, phone FROM users WHERE id = $1', [userId]);
        
        // 2. Fetch Stats (Total Cars and Total Jobs)
        const carCount = await db.query('SELECT COUNT(*) FROM vehicles WHERE owner_id = $1', [userId]);
        const jobCount = await db.query('SELECT COUNT(*) FROM jobs WHERE owner_id = $1', [userId]);

        res.render('owner/profile', { 
            user: userResult.rows[0],
            stats: {
                cars: carCount.rows[0].count,
                jobs: jobCount.rows[0].count
            },
            userId: req.session.userId
        });
    } catch (err) {
        console.error(err);
        res.status(500).send("Error loading profile");
    }
});

// GET: Show Activity History
app.get('/owner/activity', isAuthenticated, async (req, res) => {
    try {
        const userId = req.session.userId;
        const query = `
            SELECT j.*, u.full_name as mechanic_name, v.make, v.model, v.plate_number, v.id as car_id
            FROM jobs j
            LEFT JOIN users u ON j.mechanic_id = u.id
            JOIN vehicles v ON j.vehicle_id = v.id
            WHERE j.owner_id = $1
            ORDER BY j.created_at DESC
        `;
        const result = await db.query(query, [userId]);

        // Separate jobs into Pending and History, then group by date
        const pendingArray = result.rows.filter(j => j.status !== 'completed');
        const historyArray = result.rows.filter(j => j.status === 'completed');
        
        const pendingJobs = groupJobsByDate(pendingArray);
        const historyJobs = groupJobsByDate(historyArray);

        res.render('owner/activity', { 
            pendingJobs, 
            historyJobs, 
            userName: req.session.userName,
            userId: req.session.userId,
            currentPage: 'activity'
        });
    } catch (err) { console.error(err); res.status(500).send("Error"); }
});

// --- UPDATED OWNER JOB TRACKING ---
app.get('/owner/track-job/:id', isAuthenticated, async (req, res) => {
    const jobId = req.params.id;
    try {
        // 1. Fetch Job, Mechanic, and Car Info
        const jobQuery = `
            SELECT j.*, u.full_name as mechanic_name, u.phone as mechanic_phone, 
                   j.start_code, v.make, v.model, v.plate_number, v.id as car_id
            FROM jobs j 
            LEFT JOIN users u ON j.mechanic_id = u.id 
            JOIN vehicles v ON j.vehicle_id = v.id
            WHERE j.id = $1 AND j.owner_id = $2`;
        const job = await db.query(jobQuery, [jobId, req.session.userId]);

        if (job.rows.length === 0) return res.send("Job not found.");

        // Ensure accepted jobs always have a start code, even if they were accepted via older paths.
        // if (job.rows[0].status === 'accepted' && !job.rows[0].start_code) {
        //     const startCode = generateCode();
        //     await db.query('UPDATE jobs SET start_code = $1 WHERE id = $2', [startCode, jobId]);
        //     job.rows[0].start_code = startCode;
        // }

        // 2. Fetch Checklist
        const checklist = await db.query('SELECT * FROM job_checklists WHERE job_id = $1 ORDER BY id ASC', [jobId]);

        // 3. Fetch Parts (Crucial for Problem #1)
        const parts = await db.query('SELECT * FROM parts_quotes WHERE job_id = $1', [jobId]);

        // 4. Calculate Receipt Totals (Problem #2)
        const mechanicFee = 50000; // Base Fee
        const partsTotal = parts.rows.filter(p => p.is_approved).reduce((sum, p) => sum + parseFloat(p.price), 0);
        const finalTotal = mechanicFee + partsTotal;

        res.render('owner/job-tracking', {
            userId: req.session.userId,
            job: job.rows[0],
            checklist: checklist.rows,
            parts: parts.rows,
            mechanicFee,
            finalTotal
        });
    } catch (err) { console.error(err); }
});

// GET: View Job Details (Owner's perspective)
app.get('/owner/job-details/:id', isAuthenticated, async (req, res) => {
    try {
        const jobId = req.params.id;
        const userId = req.session.userId;

        // Fetch job with all related data
        const jobQuery = `
            SELECT j.*, 
                   u.full_name as mechanic_name, 
                   u.phone as mechanic_phone,
                   v.make, v.model, v.plate_number, v.year
            FROM jobs j
            LEFT JOIN users u ON j.mechanic_id = u.id
            LEFT JOIN vehicles v ON j.vehicle_id = v.id
            WHERE j.id = $1 AND j.owner_id = $2
        `;
        const jobResult = await db.query(jobQuery, [jobId, userId]);

        if (jobResult.rows.length === 0) {
            return res.status(404).send("Job not found or access denied");
        }

        // Fetch parts quotes for this job
        const partsQuery = `
            SELECT part_name, price, photo_evidence, is_approved 
            FROM parts_quotes 
            WHERE job_id = $1
            ORDER BY created_at DESC
        `;
        const partsResult = await db.query(partsQuery, [jobId]);

        res.render('owner/job-details', {
            job: jobResult.rows[0],
            parts: partsResult.rows,
            userId: req.session.userId
        });

    } catch (err) {
        console.error("Job Details Error:", err);
        res.status(500).send("Error loading job details");
    }
});

// POST: Update Profile Details
app.post('/owner/profile/update', isAuthenticated, async (req, res) => {
    const { full_name, phone } = req.body;
    try {
        await db.query('UPDATE users SET full_name = $1, phone = $2 WHERE id = $3', 
                       [full_name, phone, req.session.userId]);
        
        // Update session name in case it changed
        req.session.userName = full_name;
        res.redirect('/owner/profile');
    } catch (err) {
        console.error(err);
        res.status(500).send("Error updating profile");
    }
});

// GET: Book Maintenance
app.get('/owner/book-maintenance', isAuthenticated, async (req, res) => {
    const cars = await db.query('SELECT * FROM vehicles WHERE owner_id = $1', [req.session.userId]);
    res.render('owner/book-maintenance', { 
        cars: cars.rows,
        userId: req.session.userId,
        error: null
    });
});

// GET: Show Diagnostics Page
app.get('/owner/diagnostics', isAuthenticated, async (req, res) => {
    const cars = await db.query('SELECT * FROM vehicles WHERE owner_id = $1', [req.session.userId]);
    res.render('owner/diagnostics', { 
        cars: cars.rows,
        userId: req.session.userId
    });
});

// Legacy route compatibility: forward to new auto-dispatch booking flow.
app.post('/owner/select-mechanic', isAuthenticated, async (req, res) => {
    const { scheduled_date } = req.body;
    if (isPastScheduledDate(scheduled_date)) {
        const cars = await db.query('SELECT * FROM vehicles WHERE owner_id = $1', [req.session.userId]);
        return res.status(400).render('owner/book-maintenance', {
            cars: cars.rows,
            userId: req.session.userId,
            error: 'You cannot book a service in the past. Please choose today or a future date.'
        });
    }

    return res.redirect(307, '/owner/finalize-booking');
});

// Legacy route compatibility: forward to new auto-dispatch booking flow.
app.post('/owner/confirm-booking', isAuthenticated, async (req, res) => {
    const { scheduled_date } = req.body;
    if (isPastScheduledDate(scheduled_date)) {
        return res.status(400).send('Invalid booking date. Please select today or a future date.');
    }

    return res.redirect(307, '/owner/finalize-booking');
});

// FINAL STEP: Actually save to Database
app.post('/owner/finalize-booking', isAuthenticated, async (req, res) => {
    const { vehicle_id, service_type, scheduled_date } = req.body;
    try {
        if (isPastScheduledDate(scheduled_date)) {
            return res.status(400).send('Invalid booking date. Please select today or a future date.');
        }

        const result = await db.query(
            'INSERT INTO jobs (owner_id, mechanic_id, vehicle_id, service_type, status) VALUES ($1, $2, $3, $4, $5) RETURNING id',
            [req.session.userId, null, vehicle_id, service_type, 'pending']
        );
        
        const jobId = result.rows[0].id;

        // Create default checklist tasks for the new job
        const defaultTasks = [
            'Oil Level Checked',
            'Oil Filter Replaced',
            'Coolant Level Checked',
            'Tire Pressure Checked',
            'Brake Pads Inspected',
            'Battery Terminals Inspected',
            'Lights & Signals Tested',
            'Windshield Wipers Checked',
            'Cabin Air Filter Checked',
            'Under-Carriage Inspection'
        ];

        for (const task of defaultTasks) {
            await db.query(
                'INSERT INTO job_checklists (job_id, task_description) VALUES ($1, $2)',
                [jobId, task]
            );
        }
        
        // Send booking requests to active mechanics (online_mechanics room).
        const bookingInfo = await db.query(`
            SELECT j.id, j.owner_id, j.vehicle_id, j.service_type, j.status, j.sos_active,
                   u.full_name as owner_name, u.phone as owner_phone, u.location_lat, u.location_lng,
                   v.make, v.model, v.plate_number
            FROM jobs j
            JOIN users u ON j.owner_id = u.id
            JOIN vehicles v ON j.vehicle_id = v.id
            WHERE j.id = $1
        `, [jobId]);

        if (bookingInfo.rows.length > 0) {
            io.to('online_mechanics').emit('new_job_pushed', bookingInfo.rows[0]);
        }

        res.render('owner/booking-success', {
            service: service_type,
            date: scheduled_date,
            userId: req.session.userId,
            state: 'pending_approval'
        });
    } catch (err) { console.error(err); }
});

// GET: Show Edit Form
app.get('/owner/car/:id/edit', isAuthenticated, async (req, res) => {
    try {
        const result = await db.query('SELECT * FROM vehicles WHERE id = $1 AND owner_id = $2', [req.params.id, req.session.userId]);
        if (result.rows.length === 0) return res.send("Car not found");
        res.render('owner/edit-car', { car: result.rows[0], userId: req.session.userId });
    } catch (err) { console.error(err); }
});

// POST: Update Car Details & Append Photos
app.post('/owner/car/:id/edit', isAuthenticated, upload.array('new_photos', 5), async (req, res) => {
    const { make, model, plate, year, transmission, color, mileage, tyre_size } = req.body;
    const carId = req.params.id;

    try {
        // 1. Fetch existing photos first
        const currentCar = await db.query('SELECT photos FROM vehicles WHERE id = $1', [carId]);
        let existingPhotos = currentCar.rows[0].photos || "";

        // 2. Add new photos if any were uploaded
        if (req.files && req.files.length > 0) {
            const newPhotoPaths = req.files.map(file => '/uploads/cars/' + file.filename).join(',');
            existingPhotos = existingPhotos ? existingPhotos + ',' + newPhotoPaths : newPhotoPaths;
        }

        // 3. Update the database
        await db.query(
            `UPDATE vehicles SET make=$1, model=$2, year=$3, plate_number=$4, transmission=$5, 
             color=$6, mileage=$7, tyre_size=$8, photos=$9 WHERE id=$10 AND owner_id=$11`,
            [make, model, year, plate, transmission, color, mileage, tyre_size, existingPhotos, carId, req.session.userId]
        );

        res.redirect('/owner/car/' + carId);
    } catch (err) { console.error(err); res.send("Error updating car"); }
});

// POST: Delete Car
app.post('/owner/car/:id/delete', isAuthenticated, async (req, res) => {
    try {
        await db.query('DELETE FROM vehicles WHERE id = $1 AND owner_id = $2', [req.params.id, req.session.userId]);
        res.redirect('/owner/dashboard');
    } catch (err) { console.error(err); res.send("Error deleting car"); }
});

app.get('/owner/sos', isAuthenticated, async (req, res) => {
    try {
        const cars = await db.query('SELECT * FROM vehicles WHERE owner_id = $1', [req.session.userId]);
        res.render('owner/sos', { 
            userName: req.session.userName, 
            cars: cars.rows,
            userId: req.session.userId
        });
    } catch (err) {
        console.error(err);
        res.status(500).send("Error loading SOS page");
    }
});

    // --- SOS PAGE ROUTE ---
    app.get('/sos', isAuthenticated, async (req, res) => {
        // We pass the userName so the SOS page can show "Stay calm, [Name]"
        res.render('owner/sos', { 
            userName: req.session.userName,
            userId: req.session.userId
        });
    });

app.get('/mechanic/dashboard', isAuthenticated, (req, res) => {
    res.render('mechanic/dashboard', { 
        userName: req.session.userName,
        userId: req.session.userId // <--- ADD THIS LINE TO PREVENT ERRORS
    });
});

// GET: MECHANIC EARNINGS PAGE
app.get('/mechanic/earnings', isAuthenticated, async (req, res) => {
    const mechId = req.session.userId;

    try {
        // Completed jobs for this mechanic with vehicle info
        const jobsRes = await db.query(
            `SELECT j.id,
                    j.service_type,
                    j.total_price,
                    j.updated_at,
                    v.model
             FROM jobs j
             JOIN vehicles v ON j.vehicle_id = v.id
             WHERE j.mechanic_id = $1
               AND j.status = 'completed'
               AND j.total_price IS NOT NULL
             ORDER BY j.updated_at DESC`,
            [mechId]
        );
        const jobs = jobsRes.rows;

        // Today’s earnings
        const todayRes = await db.query(
            `SELECT COALESCE(SUM(total_price), 0) AS today
             FROM jobs
             WHERE mechanic_id = $1
               AND status = 'completed'
               AND total_price IS NOT NULL
               AND DATE(updated_at) = CURRENT_DATE`,
            [mechId]
        );
        const todayEarnings = todayRes.rows[0].today;

        // Total (or “this week”) earnings
        const totalRes = await db.query(
            `SELECT COALESCE(SUM(total_price), 0) AS total
             FROM jobs
             WHERE mechanic_id = $1
               AND status = 'completed'
               AND total_price IS NOT NULL`,
            [mechId]
        );
        const totalEarnings = totalRes.rows[0].total;

        res.render('mechanic/earnings', {
            todayEarnings,
            totalEarnings,
            jobs,
            userId: req.session.userId
        });
    } catch (err) {
        console.error(err);
        res.status(500).send('Error loading earnings');
    }
});

// --- GET: MECHANIC PROFILE ---
app.get('/mechanic/profile', isAuthenticated, async (req, res) => {
    try {
        const userRes = await db.query('SELECT * FROM users WHERE id = $1', [req.session.userId]);
        const reviewsRes = await db.query(`
            SELECT r.*, u.full_name as owner_name 
            FROM reviews r JOIN users u ON r.owner_id = u.id 
            WHERE r.mechanic_id = $1 ORDER BY r.created_at DESC`, [req.session.userId]);
        
        // Earnings summary for the profile page
        const earningsRes = await db.query("SELECT SUM(total_price) FROM jobs WHERE mechanic_id = $1 AND status = 'completed'", [req.session.userId]);

        res.render('mechanic/profile', { 
            user: userRes.rows[0], 
            reviews: reviewsRes.rows,
            totalEarnings: earningsRes.rows[0].sum || 0,
            userId: req.session.userId
        });
    } catch (err) { res.status(500).send("Error"); }
});

// Logout Route
app.get('/logout', (req, res) => {
    req.session.destroy();
    res.redirect('/login');
});

    // GET: Individual Job Card
    app.get('/mechanic/job/:id', isAuthenticated, async (req, res) => {
        try {
            const jobId = req.params.id;
        
            // Fetch Job + Owner Name + Vehicle Info in one query
            const query = `
                SELECT j.*, u.full_name as owner_name, v.make, v.model 
                FROM jobs j
                JOIN users u ON j.owner_id = u.id
                JOIN vehicles v ON j.vehicle_id = v.id
                WHERE j.id = $1
            `;
            const result = await db.query(query, [jobId]);

            if (result.rows.length === 0) return res.send("Job not found.");
        
            // Fetch parts quotes for this job
            const partsResult = await db.query(
                'SELECT * FROM parts_quotes WHERE job_id = $1 ORDER BY id',
                [jobId]
            );

            res.render('mechanic/job-card', { 
                job: result.rows[0], 
                parts: partsResult.rows,
                mechanicId: req.session.userId
            });
        } catch (err) {
            console.error(err);
            res.status(500).send("Error loading job card");
        }
    });

    // API: Get Job Checklist Tasks
    app.get('/api/mechanic/job-checklist/:jobId', isAuthenticated, async (req, res) => {
        try {
            const jobId = req.params.jobId;
            const result = await db.query(
                'SELECT id, task_description, is_completed FROM job_checklists WHERE job_id = $1 ORDER BY id',
                [jobId]
            );
            res.json(result.rows);
        } catch (err) {
            console.error('Checklist Load Error:', err);
            res.status(500).json({ error: 'Failed to load checklist' });
        }
    });

    // API: Toggle Task Completion
    app.post('/api/mechanic/check-task', isAuthenticated, async (req, res) => {
        try {
            const { taskId, isCompleted } = req.body;

            // Check if the job linked to this task is already completed
            const statusRes = await db.query(`
                SELECT j.status FROM jobs j 
                JOIN job_checklists c ON j.id = c.job_id 
                WHERE c.id = $1`, [taskId]);

            if (statusRes.rows[0].status === 'completed') {
                return res.status(403).json({ error: "Cannot edit completed jobs." });
            }

            await db.query(
                'UPDATE job_checklists SET is_completed = $1, completed_at = $2 WHERE id = $3',
                [isCompleted, isCompleted ? new Date() : null, taskId]
            );

            // Push real-time checklist updates to the owner from the server source of truth.
            const notifyRes = await db.query(`
                SELECT c.job_id, j.owner_id
                FROM job_checklists c
                JOIN jobs j ON j.id = c.job_id
                WHERE c.id = $1
                LIMIT 1
            `, [taskId]);

            if (notifyRes.rows.length > 0) {
                const { job_id: jobId, owner_id: ownerId } = notifyRes.rows[0];

                const progressRes = await db.query(
                    'SELECT COUNT(*)::int AS total, COUNT(*) FILTER (WHERE is_completed = true)::int AS completed FROM job_checklists WHERE job_id = $1',
                    [jobId]
                );

                const totals = progressRes.rows[0] || { total: 0, completed: 0 };
                const progress = Number(totals.total) > 0
                    ? Math.round((Number(totals.completed) / Number(totals.total)) * 100)
                    : 0;

                io.to('user_' + ownerId).emit('task_update', {
                    jobId,
                    taskId,
                    isCompleted,
                    total: Number(totals.total),
                    completed: Number(totals.completed),
                    progress
                });
            }

            res.json({ success: true });
        } catch (err) {
            console.error('Task Update Error:', err);
            res.status(500).json({ error: 'Failed to update task' });
        }
    });

    // --- API: SUBMIT RATING ---
    app.post('/api/owner/rate-mechanic', isAuthenticated, async (req, res) => {
        const { jobId, rating, feedback } = req.body;
        try {
            // 1. Validate that this owner owns the completed job
            const jobRes = await db.query(
                'SELECT mechanic_id, owner_id, status FROM jobs WHERE id = $1',
                [jobId]
            );

            if (jobRes.rows.length === 0) {
                return res.status(404).json({ success: false, message: 'Job not found.' });
            }

            const job = jobRes.rows[0];
            if (Number(job.owner_id) !== Number(req.session.userId)) {
                return res.status(403).json({ success: false, message: 'Unauthorized rating attempt.' });
            }

            if (job.status !== 'completed') {
                return res.status(400).json({ success: false, message: 'You can only rate completed jobs.' });
            }

            // 2. Prevent duplicate ratings for the same job
            const existingRating = await db.query('SELECT id FROM reviews WHERE job_id = $1 LIMIT 1', [jobId]);
            if (existingRating.rows.length > 0) {
                return res.json({ success: true, message: 'Already rated.' });
            }

            // 3. Get the mechanic_id for this job
            const mechanicId = jobRes.rows[0].mechanic_id;

            if (!mechanicId) {
                return res.status(400).json({ success: false, message: 'No mechanic assigned to this job.' });
            }

            // 4. Insert the review
            await db.query(
                'INSERT INTO reviews (job_id, mechanic_id, owner_id, rating, feedback) VALUES ($1, $2, $3, $4, $5)',
                [jobId, mechanicId, req.session.userId, rating, feedback]
            );

            res.json({ success: true });
        } catch (err) { console.error(err); res.status(500).send("Error saving rating"); }
    });

    // --- API: UPDATE OWNER LIVE LOCATION ---
    app.post('/api/owner/update-location', isAuthenticated, async (req, res) => {
        const { lat, lng } = req.body;

        const latitude = Number(lat);
        const longitude = Number(lng);

        if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) {
            return res.status(400).json({ success: false, message: 'Invalid coordinates.' });
        }

        try {
            await db.query(
                'UPDATE users SET location_lat = $1, location_lng = $2 WHERE id = $3',
                [latitude, longitude, req.session.userId]
            );
            res.json({ success: true });
        } catch (err) {
            console.error('Owner location update error:', err);
            res.status(500).json({ success: false, message: 'Failed to update location.' });
        }
    });

    // --- HELPER: GET MECHANIC AVG RATING ---
    async function getMechanicRating(mechId) {
        const res = await db.query('SELECT AVG(rating) as average FROM reviews WHERE mechanic_id = $1', [mechId]);
        const avg = parseFloat(res.rows[0].average) || 0;
        return avg.toFixed(1);
    }

    // --- UPDATED API: FETCH ACTIVE WORK QUEUE ---
    // --- UPDATED MECHANIC STATS API ---
    app.get('/api/mechanic/stats', isAuthenticated, async (req, res) => {
        const mechId = req.session.userId;
        try {
            // 1. Total Completed Jobs
            const totalRes = await db.query("SELECT COUNT(*) FROM jobs WHERE mechanic_id = $1 AND status = 'completed'", [mechId]);
            
            // 2. Active Jobs Count (Jobs currently being worked on)
            const activeRes = await db.query("SELECT COUNT(*) FROM jobs WHERE mechanic_id = $1 AND status IN ('accepted', 'diagnosing', 'fixing')", [mechId]);

            // 3. Average Rating
            const ratingRes = await db.query("SELECT AVG(rating) as avg FROM reviews WHERE mechanic_id = $1", [mechId]);

            res.json({
                totalJobs: totalRes.rows[0].count,
                activeJobs: activeRes.rows[0].count,
                rating: parseFloat(ratingRes.rows[0].avg || 0).toFixed(1)
            });
        } catch (err) { res.status(500).send(err.message); }
    });

    // API: Get Pending Jobs (for mechanic dashboard on page load)
    app.get('/api/mechanic/pending-jobs', isAuthenticated, async (req, res) => {
        try {
            const result = await db.query(`
                SELECT j.*, u.full_name as owner_name, u.phone as owner_phone,
                    u.location_lat, u.location_lng,
                    v.make, v.model, v.plate_number, v.fuel_type, v.tyre_size
                FROM jobs j
                JOIN users u ON j.owner_id = u.id
                JOIN vehicles v ON j.vehicle_id = v.id
                WHERE j.status = 'pending'
                ORDER BY j.created_at DESC
            `);
            res.json(result.rows);
        } catch (err) {
            console.error('Pending Jobs Error:', err);
            res.status(500).json([]);
        }
    });

    // --- UPDATED MECHANIC DATA API ---
    app.get('/api/mechanic/all-jobs', isAuthenticated, async (req, res) => {
        const mechId = req.session.userId;
        try {
            const query = `
                SELECT j.*, 
                    u.full_name as owner_name, u.phone as owner_phone, u.location_lat, u.location_lng,
                    v.make, v.model, v.plate_number 
            FROM jobs j 
            JOIN users u ON j.owner_id = u.id 
            JOIN vehicles v ON j.vehicle_id = v.id 
            WHERE j.mechanic_id = $1 OR (j.status = 'pending' AND j.mechanic_id IS NULL)
            ORDER BY j.created_at DESC`;
        
            const result = await db.query(query, [mechId]);
            const jobs = result.rows;
            const openJobs = jobs.filter(j => !['completed', 'cancelled'].includes(j.status));

            res.json({
                // SOS: all non‑completed SOS jobs (pending + in‑progress)
                sos: openJobs.filter(j => j.sos_active),
                // Bookings: all non‑completed non‑SOS jobs (pending + in‑progress)
                bookings: openJobs.filter(j => !j.sos_active),
                // Active: any job currently in progress (SOS or booking)
                active: jobs.filter(j => ['accepted', 'diagnosing', 'fixing'].includes(j.status)),
                // Completed history
                history: jobs.filter(j => j.status === 'completed')
            });
        } catch (err) {
            console.error(err);
            res.status(500).send("Error");
        }
    });

    // --- NEW ACTION: VERIFY PROBLEM (Generates Checklist) ---
    app.post('/api/mechanic/verify-problem', isAuthenticated, async (req, res) => {
        const { jobId } = req.body;
        try {
            const jobRes = await db.query('SELECT owner_id FROM jobs WHERE id = $1', [jobId]);
            if (jobRes.rows.length === 0) return res.status(404).send('Job not found');

            // Change status to active repair after mechanic has reached and approved the issue.
            await db.query("UPDATE jobs SET status = 'fixing' WHERE id = $1", [jobId]);

            // AUTO-GENERATE CHECKLIST ONCE
            const checklistCount = await db.query('SELECT COUNT(*) as count FROM job_checklists WHERE job_id = $1', [jobId]);
            if (Number(checklistCount.rows[0].count) === 0) {
                const tasks = ['Initial Inspection', 'Fluid Level Check', 'Diagnostic Scan', 'Safety Test'];
                for (let t of tasks) {
                    await db.query('INSERT INTO job_checklists (job_id, task_description) VALUES ($1, $2)', [jobId, t]);
                }
            }

            const ownerId = jobRes.rows[0].owner_id;
            io.to('user_' + ownerId).emit('job_progress_update', {
                jobId,
                status: 'fixing',
                stage: 'problem_approved',
                message: 'Mechanic has approved the problem and started the repair.'
            });
            io.to('user_' + ownerId).emit('checklist_activated', { jobId });

            io.emit('job_verified', { jobId });
            res.json({ success: true });
        } catch (err) { console.error(err); res.status(500).send("Error verifying problem"); }
    });

    // --- NEW ACTION: MECHANIC REACHED THE CAR ---
    app.post('/api/mechanic/reached-car', isAuthenticated, async (req, res) => {
        const { jobId } = req.body;
        try {
            const jobRes = await db.query('SELECT owner_id, mechanic_id FROM jobs WHERE id = $1', [jobId]);
            if (jobRes.rows.length === 0) return res.status(404).json({ success: false, message: 'Job not found.' });

            // When mechanic reaches the car, immediately start the job and activate checklist.
            await db.query("UPDATE jobs SET status = 'fixing' WHERE id = $1", [jobId]);

            const checklistCount = await db.query('SELECT COUNT(*) as count FROM job_checklists WHERE job_id = $1', [jobId]);
            if (Number(checklistCount.rows[0].count) === 0) {
                const tasks = ['Initial Inspection', 'Fluid Level Check', 'Diagnostic Scan', 'Safety Test'];
                for (const task of tasks) {
                    await db.query('INSERT INTO job_checklists (job_id, task_description) VALUES ($1, $2)', [jobId, task]);
                }
            }

            io.to('user_' + jobRes.rows[0].owner_id).emit('job_progress_update', {
                jobId,
                status: 'fixing',
                stage: 'arrived',
                message: 'Mechanic has reached your car and started the repair.'
            });

            io.to('user_' + jobRes.rows[0].owner_id).emit('checklist_activated', { jobId });

            res.json({ success: true });
        } catch (err) {
            console.error(err);
            res.status(500).json({ success: false, message: 'Error updating arrival status.' });
        }
    });

    // --- API: VERIFY START CODE ---
    // app.post('/api/mechanic/verify-start-code', isAuthenticated, async (req, res) => {
    //     const { jobId, codeInput } = req.body;
    //     try {
    //         const job = await db.query('SELECT start_code FROM jobs WHERE id = $1', [jobId]);

    //         if (job.rows.length === 0) {
    //             return res.status(404).json({ success: false, message: 'Job not found.' });
    //         }

    //         if (job.rows[0].start_code === codeInput) {
    //             await db.query("UPDATE jobs SET status = 'fixing' WHERE id = $1", [jobId]);
    //             req.io.emit('job_started_live', { jobId });
    //             return res.json({ success: true });
    //         }

    //         return res.json({ success: false, message: 'Invalid Code. Ask owner for the 4-digit code.' });
    //     } catch (err) {
    //         console.error(err);
    //         return res.status(500).send('Error');
    //     }
    // });

    // --- UPDATE JOB STATUS/STAGE ---
    app.post('/api/mechanic/update-stage', isAuthenticated, async (req, res) => {
        const { jobId, newStatus } = req.body;
        const mechId = req.session.userId;
        
        try {
            // Update job status and assign mechanic if accepting
            if (newStatus === 'accepted') {
                // const startCode = generateCode();
                await db.query(
                    "UPDATE jobs SET status = $1, mechanic_id = $2 WHERE id = $3",
                    [newStatus, mechId, jobId]
                );

                const jobRes = await db.query('SELECT owner_id FROM jobs WHERE id = $1', [jobId]);
                if (jobRes.rows.length > 0) {
                    io.to('user_' + jobRes.rows[0].owner_id).emit('job_progress_update', {
                        jobId,
                        status: 'accepted',
                        stage: 'accepted',
                        message: 'A mechanic accepted your job and is heading to your location.'
                    });
                }
            } else {
                await db.query("UPDATE jobs SET status = $1 WHERE id = $2", [newStatus, jobId]);
            }
            
            // Emit real-time update to owner
            io.emit('job_status_updated', { jobId, status: newStatus });
            res.json({ success: true });
        } catch (err) { 
            console.error('Update Stage Error:', err); 
            res.status(500).send("Error updating job status"); 
        }
    });

    // --- 1. TOGGLE ONLINE STATUS ---
    app.post('/api/mechanic/toggle-status', isAuthenticated, async (req, res) => {
        const { isOnline } = req.body;
        try {
            await db.query('UPDATE users SET is_online = $1 WHERE id = $2', [isOnline, req.session.userId]);
            res.json({ success: true });
        } catch (err) { res.status(500).send(err.message); }
    });

    // --- UPDATE MECHANIC PROFILE ---
    app.post('/api/mechanic/update-profile', isAuthenticated, async (req, res) => {
        const { full_name, garage_name, garage_location, expertise } = req.body;
        try {
            await db.query(
                'UPDATE users SET full_name=$1, garage_name=$2, garage_location=$3, expertise=$4 WHERE id=$5',
                [full_name, garage_name, garage_location, expertise, req.session.userId]
            );
            res.json({ success: true });
        } catch (err) { res.status(500).send(err.message); }
    });

    // --- 3. APPROVE/DECLINE APPOINTMENT ---
    app.post('/api/mechanic/respond-appointment', isAuthenticated, async (req, res) => {
        const { jobId, decision } = req.body; // decision: 'accepted' or 'cancelled'
        try {
            if (!['accepted', 'cancelled'].includes(decision)) {
                return res.status(400).json({ success: false, message: 'Invalid decision value.' });
            }

            const mechanicRes = await db.query(
                'SELECT full_name, phone, garage_location FROM users WHERE id = $1',
                [req.session.userId]
            );

            const jobOwnerRes = await db.query('SELECT owner_id FROM jobs WHERE id = $1', [jobId]);
            if (jobOwnerRes.rows.length === 0) {
                return res.status(404).send('Job not found');
            }

            const ownerId = jobOwnerRes.rows[0].owner_id;
            const mechanic = mechanicRes.rows[0] || {};

            if (decision === 'accepted') {
                // const startCode = generateCode();
                const updateRes = await db.query(
                    "UPDATE jobs SET status = $1, mechanic_id = $2 WHERE id = $3 AND status = 'pending' AND mechanic_id IS NULL",
                    [decision, req.session.userId, jobId]
                );

                if (updateRes.rowCount === 0) {
                    return res.status(409).json({ success: false, message: 'This booking is no longer available for approval.' });
                }

                const jobRes = await db.query('SELECT owner_id FROM jobs WHERE id = $1', [jobId]);
                if (jobRes.rows.length > 0) {
                    io.to('user_' + jobRes.rows[0].owner_id).emit('job_progress_update', {
                        jobId,
                        status: 'accepted',
                        stage: 'accepted',
                        message: 'A mechanic accepted your booking and is on the way.'
                    });
                }

                io.to('user_' + ownerId).emit('appointment_update', {
                    jobId,
                    decision,
                    mechanicName: mechanic.full_name || req.session.userName,
                    mechanicPhone: mechanic.phone || null,
                    garageLocation: mechanic.garage_location || null,
                    professionalMessage: `Booking approved by ${mechanic.full_name || req.session.userName}. Contact: ${mechanic.phone || 'Not provided'}${mechanic.garage_location ? ` | Garage: ${mechanic.garage_location}` : ''}`
                });
            } else {
                const updateRes = await db.query(
                    "UPDATE jobs SET status = $1, mechanic_id = $2 WHERE id = $3 AND status = 'pending' AND mechanic_id IS NULL",
                    [decision, req.session.userId, jobId]
                );

                if (updateRes.rowCount === 0) {
                    return res.status(409).json({ success: false, message: 'This booking was already handled by another mechanic.' });
                }

                io.to('user_' + ownerId).emit('appointment_update', {
                    jobId,
                    decision,
                    mechanicName: mechanic.full_name || req.session.userName,
                    mechanicPhone: mechanic.phone || null,
                    garageLocation: mechanic.garage_location || null,
                    professionalMessage: `Your booking request was declined by ${mechanic.full_name || req.session.userName}. Please select another available mechanic.`
                });
            }
            
            res.json({ success: true });
        } catch (err) {
            res.status(500).json({ success: false, message: err.message || 'Failed to process booking response.' });
        }
    });

    // 1. GET: Show the Quote Form
    app.get('/mechanic/job/:id/quote', isAuthenticated, (req, res) => {
        res.render('mechanic/quote-part', { 
        jobId: req.params.id,
        userId: req.session.userId
    });
    });

    // 2. POST: Process the Quote & Notify Owner
    // --- UPDATE: Support Multiple Photos for Quotes ---
    app.post('/mechanic/job/:id/quote', isAuthenticated, upload.array('part_photos', 5), async (req, res) => {
        const jobId = req.params.id;
        const { part_name, price } = req.body;
        
        // Save multiple paths as a comma-separated string
        const photoPaths = req.files ? req.files.map(f => '/uploads/parts/' + f.filename).join(',') : '';

        try {
            await db.query(
                'INSERT INTO parts_quotes (job_id, part_name, price, photo_evidence, is_approved) VALUES ($1, $2, $3, $4, NULL)',
                [jobId, part_name, price, photoPaths]
            );

            // Fetch owner_id to send a targeted real-time alert
            const jobData = await db.query('SELECT owner_id FROM jobs WHERE id = $1', [jobId]);
            const ownerId = jobData.rows[0].owner_id;

            // Socket.io Real-time Alert: "Owner, you have a new quote!"
            io.emit('new_quote_alert', { 
                ownerId: ownerId, 
                partName: part_name, 
                price: price 
            });

            res.redirect('/mechanic/job/' + jobId);
        } catch (err) { console.error(err); res.status(500).send('Error submitting quote'); }
    });

// --- API: RESPOND TO QUOTE (Approve or Decline) ---
app.post('/api/owner/respond-quote', isAuthenticated, async (req, res) => {
    const { partId, decision, jobId } = req.body;
    
    console.log('Received quote response:', { partId, decision, jobId }); // Debug log
    
    try {
        if (decision === 'approve') {
            await db.query('UPDATE parts_quotes SET is_approved = true WHERE id = $1', [partId]);
        } else if (decision === 'reject') {
            await db.query('UPDATE parts_quotes SET is_approved = false WHERE id = $1', [partId]);
        }
        
        // Notify mechanic
        io.emit('quote_updated', { jobId, partId, decision });

        res.json({ success: true });
    } catch (err) { 
        console.error('Error updating quote:', err);
        res.status(500).json({ success: false, message: err.message }); 
    }
});

// --- LEGACY: Keep old endpoint for backward compatibility ---
app.post('/api/owner/approve-part', isAuthenticated, async (req, res) => {
    const { partId, jobId } = req.body;
    try {
        await db.query('UPDATE parts_quotes SET is_approved = true WHERE id = $1', [partId]);
        io.emit('part_approved_live', { jobId: jobId, partId: partId });
        res.json({ success: true, message: "Part Approved" });
    } catch (err) {
        console.error(err);
        res.status(500).json({ success: false, message: "Server Error" });
    }
});

// POST: Mechanic Finishes the Job
app.post('/mechanic/job/:id/complete', isAuthenticated, async (req, res) => {
    const jobId = req.params.id;

    try {
        // 1. Calculate the Total (Base Service + Approved Parts)
        const jobData = await db.query('SELECT owner_id, service_type FROM jobs WHERE id = $1', [jobId]);
        const partsTotal = await db.query('SELECT SUM(price) FROM parts_quotes WHERE job_id = $1 AND is_approved = true', [jobId]);
        
        const serviceFee = 50000; // Base fee example
        const total = serviceFee + (parseFloat(partsTotal.rows[0].sum) || 0);

        // 2. Update Job Status to 'completed'
        await db.query('UPDATE jobs SET status = $1, total_price = $2 WHERE id = $3', ['completed', total, jobId]);

        // 3. Generate the PDF Receipt (Stored in public/receipts/)
        const doc = new PDFDocument();
        const receiptPath = `/receipts/receipt-${jobId}.pdf`;
        doc.pipe(fs.createWriteStream('./public' + receiptPath));

        doc.fontSize(25).text('MyCarRepair - Official Receipt', { align: 'center' });
        doc.moveDown();
        doc.fontSize(14).text(`Service: ${jobData.rows[0].service_type}`);
        doc.text(`Total Paid: UGX ${total.toLocaleString()}`);
        doc.moveDown();
        doc.text('Thank you for choosing a Trusted Mechanic!', { align: 'center', color: 'grey' });
        doc.end();

        // 4. Notify the Owner instantly
        io.emit('job_finished', { 
            jobId: jobId,
            ownerId: jobData.rows[0].owner_id, 
            receiptUrl: receiptPath,
            total: total 
        });

        res.redirect('/mechanic/dashboard');
    } catch (err) { console.error(err); }
});

// --- SOCKET.IO REAL-TIME LOGIC ---
io.on('connection', async (socket) => {
    console.log('📡 User Online:', socket.id);

    // Join a private room based on User ID so we can send targeted alerts.
    socket.on('join_room', (userId) => {
        socket.join('user_' + userId);
        console.log(`👤 User ${userId} joined their private notification room.`);
    });

    // Check if this is an online mechanic and join them to the room
    const session = socket.request.session;
    if (session && session.userId && session.role === 'mechanic') {
        try {
            const result = await db.query('SELECT is_online FROM users WHERE id = $1', [session.userId]);
            if (result.rows.length > 0 && result.rows[0].is_online) {
                socket.join('online_mechanics');
                console.log(`Mechanic ${session.userId} joined online_mechanics room`);
            }
        } catch (err) {
            console.error('Error checking mechanic status:', err);
        }
    }

    // Handle mechanic status changes (join/leave online_mechanics room)
    socket.on('mechanic_status_changed', (data) => {
        if (data.isOnline) {
            socket.join('online_mechanics');
            console.log(`Mechanic ${session?.userId} joined online_mechanics room`);
        } else {
            socket.leave('online_mechanics');
            console.log(`Mechanic ${session?.userId} left online_mechanics room`);
        }
    });

    // --- SOS HANDLER WITH GPS COORDINATES ---
    socket.on('emergency_sos', async (data) => {
        try {
            const userId = socket.request.session.userId;

            // Keep owner's latest precise coordinates for mechanic navigation, including refreshes.
            await db.query(
                'UPDATE users SET location_lat = $1, location_lng = $2 WHERE id = $3',
                [data.lat, data.lng, userId]
            );
            
            // 1. Save Job with the EXACT coordinates provided by the owner's GPS
            const newJob = await db.query(
                'INSERT INTO jobs (owner_id, vehicle_id, service_type, status, sos_active) VALUES ($1, $2, $3, $4, $5) RETURNING id',
                [userId, data.vehicleId, data.issue, 'pending', true]
            );
            const jobId = newJob.rows[0].id;

            // 2. Confirm to the Owner so they can start listening for 'job_taken'
            socket.emit('sos_confirmed', { jobId: jobId });

            // 3. Fetch full details for the mechanics (including the new Lat/Lng)
            const carRes = await db.query('SELECT * FROM vehicles WHERE id = $1', [data.vehicleId]);
            const car = carRes.rows[0];

            // 4. PUSH TO MECHANICS
            io.emit('new_job_pushed', {
                id: jobId,
                owner_id: userId,
                owner_name: data.ownerName,
                make: car.make,
                model: car.model,
                plate_number: car.plate_number,
                service_type: data.issue,
                sos_active: true,
                // SEND EXACT GPS
                location_lat: data.lat,
                location_lng: data.lng
            });

        } catch (err) { console.error(err); }
    });

    // --- CANCEL SOS ---
    socket.on('cancel_sos', async () => {
        try {
            const session = socket.request.session;
            if (!session || !session.userId) return;

            await db.query('UPDATE jobs SET status = $1, sos_active = $2 WHERE owner_id = $3 AND status = $4', 
                           ['completed', false, session.userId, 'pending']);
            
            io.emit('sos_cancelled', { ownerName: session.userName });
        } catch (err) { console.error(err); }
    });

    socket.on('accept_job', async (data) => {
        const mechanicId = socket.request.session.userId;
        const jobId = data.jobId;

        try {
            // 1. ATOMIC CHECK: Is the job still available?
            const checkJob = await db.query('SELECT mechanic_id, status, owner_id FROM jobs WHERE id = $1', [jobId]);

            if (checkJob.rows.length === 0) {
                return socket.emit('app_notification', {
                    message: 'Job no longer exists.',
                    type: 'error'
                });
            }

            if (checkJob.rows[0].mechanic_id !== null) {
                return socket.emit('app_notification', {
                    message: 'Too late! Another mechanic already accepted this job.',
                    type: 'error'
                });
            }

            // 2. TIE-BREAKER LOGIC: Fetch this mechanic's rating
            const mechRes = await db.query(`
                SELECT u.full_name, u.phone, COALESCE(AVG(r.rating), 0) as avg_rating
                FROM users u LEFT JOIN reviews r ON u.id = r.mechanic_id
                WHERE u.id = $1 GROUP BY u.id`, [mechanicId]);

            if (mechRes.rows.length === 0) {
                return socket.emit('app_notification', {
                    message: 'Mechanic profile not found.',
                    type: 'error'
                });
            }

            const mech = mechRes.rows[0];
            // 3. UPDATE DB: Assign mechanic without the Start Code
            await db.query(
                `UPDATE jobs SET mechanic_id = $1, status = 'accepted' WHERE id = $2`,
                [mechanicId, jobId]
            );

            // 4. NOTIFY OWNER: Send the acceptance event only
            // io.to('user_' + checkJob.rows[0].owner_id).emit('job_accepted_with_code', {
            //     mechanicName: mech.full_name,
            //     mechanicPhone: mech.phone,
            //     mechanicRating: mech.avg_rating,
            //     startCode: startCode,
            //     jobId: jobId
            // });

            // Keep legacy event for existing listeners
            io.emit('job_taken', {
                jobId: jobId,
                ownerId: checkJob.rows[0].owner_id,
                mechanicName: mech.full_name,
                mechanicPhone: mech.phone,
                mechanicRating: mech.avg_rating
            });

            io.to('user_' + checkJob.rows[0].owner_id).emit('job_progress_update', {
                jobId,
                status: 'accepted',
                stage: 'accepted',
                mechanicName: mech.full_name,
                message: 'A mechanic accepted your job and is driving to your location.'
            });

            // 5. CONFIRM TO MECHANIC
            socket.emit('acceptance_success', { jobId: jobId });
        } catch (err) {
            console.error(err);
        }
    });

    // Fallback relay for legacy clients that still emit task_update from browser-side JS.
    socket.on('task_update', async (data) => {
        if (!data || !data.jobId) return;

        try {
            const ownerRes = await db.query('SELECT owner_id FROM jobs WHERE id = $1 LIMIT 1', [data.jobId]);
            if (ownerRes.rows.length === 0) return;

            io.to('user_' + ownerRes.rows[0].owner_id).emit('task_update', {
                jobId: data.jobId,
                taskId: data.taskId,
                isCompleted: data.isCompleted,
                progress: data.progress
            });
        } catch (err) {
            console.error('task_update relay error:', err);
        }
    });

    socket.on('disconnect', () => {
        console.log('📡 User Offline');
    });
});

// --- START SERVER ---
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`🚗 MyCarRepair Server running at http://localhost:${PORT}`);
});