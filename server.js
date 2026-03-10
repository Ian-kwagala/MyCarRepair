// Load environment variables from .env file
require('dotenv').config();

const express = require('express');
const http = require('http');
const path = require('path');
const { Server } = require('socket.io');
const bcrypt = require('bcryptjs');
const db = require('./db'); // Import the DB connection we made earlier
const session = require('express-session');
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

// --- SESSION SETUP ---
// 1. Define the session middleware separately so we can share it
const sessionMiddleware = session({
    secret: 'mycarrepair_secret_key_2026',
    resave: false,
    saveUninitialized: true,
    cookie: { secure: false }
});

// 2. Tell Express to use it
app.use(sessionMiddleware);

// 3. Tell Socket.io to use it (This fixes your crash!)
io.engine.use(sessionMiddleware);

// --- MULTER FILE UPLOAD CONFIGURATION ---
// Configure how files are stored
const storage = multer.diskStorage({
    destination: (req, file, cb) => {
        cb(null, 'public/uploads/cars/'); // Ensure this folder exists!
    },
    filename: (req, file, cb) => {
        // Create a unique filename: car-timestamp.jpg
        cb(null, 'car-' + Date.now() + path.extname(file.originalname));
    }
});

const upload = multer({ storage: storage });

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
    io.emit('new_job_pushed', result.rows[0]);
}

// HELPER: Group jobs by human-friendly dates
function groupJobs(jobs) {
    const groups = { Today: [], Yesterday: [], Older: [] };
    const today = new Date().toDateString();
    const yesterday = new Date(Date.now() - 86400000).toDateString();

    jobs.forEach(job => {
        const jobDate = new Date(job.created_at).toDateString();
        if (jobDate === today) groups.Today.push(job);
        else if (jobDate === yesterday) groups.Yesterday.push(job);
        else groups.Older.push(job);
    });
    return groups;
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
    res.render('owner/add-car');
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
        
        res.render('owner/dashboard', { 
            userName: req.session.userName, 
            userId: req.session.userId, // <--- ADD THIS LINE
            cars: vehicles.rows,
            activeJob: activeJob.rows[0]
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
            userName: req.session.userName
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
            }
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
        
        const pendingJobs = groupJobs(pendingArray);
        const historyJobs = groupJobs(historyArray);

        res.render('owner/activity', { 
            pendingJobs, 
            historyJobs, 
            userName: req.session.userName,
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
                   v.make, v.model, v.plate_number, v.id as car_id
            FROM jobs j 
            LEFT JOIN users u ON j.mechanic_id = u.id 
            JOIN vehicles v ON j.vehicle_id = v.id
            WHERE j.id = $1 AND j.owner_id = $2`;
        const jobRes = await db.query(jobQuery, [jobId, req.session.userId]);

        if (jobRes.rows.length === 0) return res.send("Job not found.");

        // 2. Fetch Checklist
        const checklist = await db.query('SELECT * FROM job_checklists WHERE job_id = $1 ORDER BY id ASC', [jobId]);

        // 3. Fetch Parts (Crucial for Problem #1)
        const parts = await db.query('SELECT * FROM parts_quotes WHERE job_id = $1', [jobId]);

        // 4. Calculate Receipt Totals (Problem #2)
        const mechanicFee = 50000; // Base Fee
        const partsTotal = parts.rows.filter(p => p.is_approved).reduce((sum, p) => sum + parseFloat(p.price), 0);
        const finalTotal = mechanicFee + partsTotal;

        res.render('owner/job-tracking', {
            job: jobRes.rows[0],
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
            parts: partsResult.rows
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
    res.render('owner/book-maintenance', { cars: cars.rows });
});

// GET: Show Diagnostics Page
app.get('/owner/diagnostics', isAuthenticated, async (req, res) => {
    const cars = await db.query('SELECT * FROM vehicles WHERE owner_id = $1', [req.session.userId]);
    res.render('owner/diagnostics', { cars: cars.rows });
});

// --- STEP 2: SHOW MECHANICS (RECEIVE POST FROM STEP 1) ---
app.post('/owner/select-mechanic', isAuthenticated, async (req, res) => {
    // 1. Get the data submitted from Step 1
    const { vehicle_id, service_type, scheduled_date } = req.body;

    try {
        // 2. Fetch all mechanics from the database to display in Step 2
        const result = await db.query("SELECT id, full_name, phone FROM users WHERE role = 'mechanic'");
        
        // 3. Render Step 2 (Select Mechanic) and pass all the data
        res.render('owner/select-mechanic', { 
            vehicle_id, 
            service_type, 
            scheduled_date, 
            mechanics: result.rows 
        });
    } catch (err) {
        console.error("Error in Step 2:", err);
        res.status(500).send("Could not load mechanics.");
    }
});

// --- FINAL STEP: CONFIRM & SAVE JOB ---
// --- FINAL STEP: SAVE & SHOW SUCCESS ---
// STEP 2 -> STEP 3 (The Review Page)
app.post('/owner/confirm-booking', isAuthenticated, async (req, res) => {
    const { vehicle_id, mechanic_id, service_type, scheduled_date } = req.body;

    try {
        // Fetch Car and Mechanic names to show on the review page
        const vehicleResult = await db.query('SELECT * FROM vehicles WHERE id = $1', [vehicle_id]);
        const mechanicResult = await db.query('SELECT id, full_name FROM users WHERE id = $1', [mechanic_id]);

        res.render('owner/confirm-booking', {
            vehicle: vehicleResult.rows[0],
            mechanic: mechanicResult.rows[0],
            service_type,
            scheduled_date
        });
    } catch (err) {
        console.error(err);
        res.status(500).send("Error loading confirmation page");
    }
});

// FINAL STEP: Actually save to Database
app.post('/owner/finalize-booking', isAuthenticated, async (req, res) => {
    const { vehicle_id, mechanic_id, service_type, scheduled_date } = req.body;
    try {
        const result = await db.query(
            'INSERT INTO jobs (owner_id, mechanic_id, vehicle_id, service_type, status) VALUES ($1, $2, $3, $4, $5) RETURNING id',
            [req.session.userId, mechanic_id, vehicle_id, service_type, 'pending']
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
        
        // PUSH REAL-TIME DATA TO MECHANIC
        broadcastJob(jobId);

        res.render('owner/booking-success', { service: service_type, date: scheduled_date });
    } catch (err) { console.error(err); }
});

// GET: Show Edit Form
app.get('/owner/car/:id/edit', isAuthenticated, async (req, res) => {
    try {
        const result = await db.query('SELECT * FROM vehicles WHERE id = $1 AND owner_id = $2', [req.params.id, req.session.userId]);
        if (result.rows.length === 0) return res.send("Car not found");
        res.render('owner/edit-car', { car: result.rows[0] });
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
        res.render('owner/sos', { userName: req.session.userName, cars: cars.rows });
    } catch (err) {
        console.error(err);
        res.status(500).send("Error loading SOS page");
    }
});

    // --- SOS PAGE ROUTE ---
    app.get('/sos', isAuthenticated, async (req, res) => {
        // We pass the userName so the SOS page can show "Stay calm, [Name]"
        res.render('owner/sos', { 
            userName: req.session.userName 
        });
    });

app.get('/mechanic/dashboard', isAuthenticated, (req, res) => {
    res.render('mechanic/dashboard', { 
        userName: req.session.userName,
        userId: req.session.userId // <--- ADD THIS LINE TO PREVENT ERRORS
    });
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
                parts: partsResult.rows 
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
            await db.query(
                'UPDATE job_checklists SET is_completed = $1, completed_at = $2 WHERE id = $3',
                [isCompleted, isCompleted ? new Date() : null, taskId]
            );
            res.json({ success: true });
        } catch (err) {
            console.error('Task Update Error:', err);
            res.status(500).json({ error: 'Failed to update task' });
        }
    });

    // --- UPDATED API: FETCH ACTIVE WORK QUEUE ---
    app.get('/api/mechanic/stats', isAuthenticated, async (req, res) => {
        const mechId = req.session.userId;
        try {
            // 1. Current Work Queue (Accepted, Diagnosing, or Fixing)
            const activeJobsRes = await db.query(`
                SELECT j.*, u.full_name as owner_name, v.make, v.model, v.plate_number 
                FROM jobs j 
                JOIN users u ON j.owner_id = u.id 
                JOIN vehicles v ON j.vehicle_id = v.id 
                WHERE j.mechanic_id = $1 AND j.status NOT IN ('pending', 'completed')
                ORDER BY j.updated_at DESC`, 
                [mechId]
            );

            // 2. Earnings and Counters
            const todayRes = await db.query("SELECT SUM(total_price) FROM jobs WHERE mechanic_id = $1 AND status = 'completed' AND updated_at >= CURRENT_DATE", [mechId]);
            const totalJobsRes = await db.query("SELECT COUNT(*) FROM jobs WHERE mechanic_id = $1 AND status = 'completed'", [mechId]);

            res.json({
                activeJobs: activeJobsRes.rows,
                todayEarnings: todayRes.rows[0].sum || 0,
                completedCount: totalJobsRes.rows[0].count
            });
        } catch (err) { console.error(err); res.status(500).send("Stats Error"); }
    });

    // API: Get Pending Jobs (for mechanic dashboard on page load)
    app.get('/api/mechanic/pending-jobs', isAuthenticated, async (req, res) => {
        try {
            const result = await db.query(`
                SELECT j.*, u.full_name as owner_name, u.phone as owner_phone,
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

    // UPDATE: The Mechanic Dashboard Data Route
    app.get('/api/mechanic/all-jobs', isAuthenticated, async (req, res) => {
        const mechId = req.session.userId;
        try {
            const result = await db.query(`
                SELECT j.*, u.full_name as owner_name, v.make, v.model, v.plate_number, v.id as car_id
                FROM jobs j 
                JOIN users u ON j.owner_id = u.id 
                JOIN vehicles v ON j.vehicle_id = v.id 
                WHERE j.mechanic_id = $1 OR j.status = 'pending'
                ORDER BY j.created_at DESC`, [mechId]);

            const pending = result.rows.filter(j => j.status === 'pending');
            const active = result.rows.filter(j => ['accepted', 'diagnosing', 'fixing'].includes(j.status) && j.mechanic_id === mechId);
            const history = result.rows.filter(j => j.status === 'completed' && j.mechanic_id === mechId);

            res.json({
                pending: groupJobs(pending),
                active: groupJobs(active),
                history: groupJobs(history)
            });
        } catch (err) { console.error(err); res.status(500).send("Error"); }
    });

    // --- NEW ACTION: VERIFY PROBLEM (Generates Checklist) ---
    app.post('/api/mechanic/verify-problem', isAuthenticated, async (req, res) => {
        const { jobId } = req.body;
        try {
            // Change status to 'fixing' (This acts as your "Pending" verified state)
            await db.query("UPDATE jobs SET status = 'fixing' WHERE id = $1", [jobId]);
            
            // AUTO-GENERATE CHECKLIST
            const tasks = ['Initial Inspection', 'Fluid Level Check', 'Diagnostic Scan', 'Safety Test'];
            for (let t of tasks) {
                await db.query('INSERT INTO job_checklists (job_id, task_description) VALUES ($1, $2)', [jobId, t]);
            }
            
            io.emit('job_verified', { jobId });
            res.json({ success: true });
        } catch (err) { console.error(err); res.status(500).send("Error verifying problem"); }
    });

    // --- UPDATE JOB STATUS/STAGE ---
    app.post('/api/mechanic/update-stage', isAuthenticated, async (req, res) => {
        const { jobId, newStatus } = req.body;
        const mechId = req.session.userId;
        
        try {
            // Update job status and assign mechanic if accepting
            if (newStatus === 'accepted') {
                await db.query("UPDATE jobs SET status = $1, mechanic_id = $2 WHERE id = $3", [newStatus, mechId, jobId]);
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

    // 1. GET: Show the Quote Form
    app.get('/mechanic/job/:id/quote', isAuthenticated, (req, res) => {
        res.render('mechanic/quote-part', { jobId: req.params.id });
    });

    // 2. POST: Process the Quote & Notify Owner
    app.post('/mechanic/job/:id/quote', isAuthenticated, upload.single('part_photo'), async (req, res) => {
        const { part_name, price } = req.body;
        const jobId = req.params.id;
        // Ensure the path is correct for the browser
        const photoPath = req.file ? '/uploads/parts/' + req.file.filename : null;

        try {
            // Save to database
            const newQuote = await db.query(
                'INSERT INTO parts_quotes (job_id, part_name, price, photo_evidence) VALUES ($1, $2, $3, $4) RETURNING id',
                [jobId, part_name, price, photoPath]
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
        } catch (err) { console.error(err); }
    });

// --- API: OWNER APPROVES A PART ---
app.post('/api/owner/approve-part', isAuthenticated, async (req, res) => {
    const { partId, jobId } = req.body;
    try {
        // 1. Update the 'is_approved' column in the database
        await db.query('UPDATE parts_quotes SET is_approved = true WHERE id = $1', [partId]);

        // 2. Meaningful Comment: Notify the mechanic in real-time
        // This tells the mechanic's screen to show the part as "Authorized"
        io.emit('part_approved_live', { 
            jobId: jobId, 
            partId: partId 
        });

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
            ownerId: jobData.rows[0].owner_id, 
            receiptUrl: receiptPath,
            total: total 
        });

        res.redirect('/mechanic/dashboard');
    } catch (err) { console.error(err); }
});

// --- SOCKET.IO REAL-TIME LOGIC ---
io.on('connection', (socket) => {
    console.log('User connected: ' + socket.id);

    // --- NEW SOS HANDLER WITH PERSISTENCE ---
    socket.on('emergency_sos', async (data) => {
        try {
            // 1. Fetch the technical details for the specific car selected
            const vehicleRes = await db.query('SELECT * FROM vehicles WHERE id = $1', [data.vehicleId]);
            const car = vehicleRes.rows[0];

            // 2. Fetch owner's phone
            const userRes = await db.query('SELECT phone FROM users WHERE id = $1', [socket.request.session.userId]);
            const phone = userRes.rows[0].phone;

            // 3. Save the job
            const newJob = await db.query(
                'INSERT INTO jobs (owner_id, vehicle_id, service_type, status, sos_active) VALUES ($1, $2, $3, $4, $5) RETURNING id',
                [socket.request.session.userId, car.id, data.issue, 'pending', true]
            );

            // 4. Meaningful Comment: Send the "SMART DATA" to all mechanics
            const jobId = newJob.rows[0].id;

            // 1. Tell the sender (Owner) their Job ID
            socket.emit('sos_confirmed', { jobId: jobId });

            // 2. Tell the mechanics there is a new job
            broadcastJob(jobId);

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

    // --- UPDATED: Mechanic Accepts Job ---
    socket.on('accept_job', async (data) => {
        try {
            const mechanicId = socket.request.session.userId;

            // 1. Update the database
            const res = await db.query(
                'UPDATE jobs SET mechanic_id = $1, status = $2 WHERE id = $3 RETURNING owner_id', 
                [mechanicId, 'accepted', data.jobId]
            );

            // 2. Fetch Mechanic details (Name and Phone)
            const mechRes = await db.query('SELECT full_name, phone FROM users WHERE id = $1', [mechanicId]);
            const mechanic = mechRes.rows[0];

            // 3. Meaningful Comment: Tell everyone this job is taken, 
            // but include the info needed for the owner's "Green Screen"
            io.emit('job_taken', {
                jobId: data.jobId,
                ownerId: res.rows[0].owner_id,
                mechanicName: mechanic.full_name,
                mechanicPhone: mechanic.phone
            });

        } catch (err) { console.error(err); }
    });

    socket.on('disconnect', () => {
        console.log('User disconnected');
    });
});

// --- START SERVER ---
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`🚗 MyCarRepair Server running at http://localhost:${PORT}`);
});