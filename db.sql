CREATE TABLE users (
    id SERIAL PRIMARY KEY,
    full_name VARCHAR(100) NOT NULL,
    email VARCHAR(100) UNIQUE NOT NULL,
    password TEXT NOT NULL,
    phone VARCHAR(20),
    role VARCHAR(20) CHECK (role IN ('owner', 'mechanic')),
    location_lat DECIMAL(9,6), -- To find 5 nearest mechanics
    location_lng DECIMAL(9,6),
    is_online BOOLEAN DEFAULT FALSE,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE vehicles (
    id SERIAL PRIMARY KEY,
    owner_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
    make VARCHAR(50),
    model VARCHAR(50),
    year INTEGER,
    plate_number VARCHAR(20),
    fuel_type VARCHAR(20),
    last_service_date DATE,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
-- CREATE TYPE job_status AS ENUM ('pending', 'accepted', 'diagnosing', 'fixing', 'ready', 'completed');

CREATE TABLE jobs (
    id SERIAL PRIMARY KEY,
    owner_id INTEGER REFERENCES users(id),
    mechanic_id INTEGER REFERENCES users(id),
    vehicle_id INTEGER REFERENCES vehicles(id),
    service_type VARCHAR(50), -- e.g., 'Flat Tire', 'Oil Change'
    status job_status DEFAULT 'pending',
    total_price DECIMAL(12,2) DEFAULT 0.00,
    sos_active BOOLEAN DEFAULT FALSE,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE job_checklists (
    id SERIAL PRIMARY KEY,
    job_id INTEGER REFERENCES jobs(id) ON DELETE CASCADE,
    task_description VARCHAR(255) NOT NULL,
    is_completed BOOLEAN DEFAULT FALSE,
    photo_url TEXT, -- Stores the "mandatory evidence" photo path
    completed_at TIMESTAMP
);
CREATE TABLE parts_quotes (
    id SERIAL PRIMARY KEY,
    job_id INTEGER REFERENCES jobs(id) ON DELETE CASCADE,
    part_name VARCHAR(100) NOT NULL,
    price DECIMAL(12,2) NOT NULL,
    photo_evidence TEXT, -- Link to image of the part needed
    is_approved BOOLEAN DEFAULT FALSE,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE reviews (
    id SERIAL PRIMARY KEY,
    job_id INTEGER REFERENCES jobs(id) ON DELETE CASCADE,
    mechanic_id INTEGER REFERENCES users(id),
    owner_id INTEGER REFERENCES users(id),
    rating INTEGER CHECK (rating >= 1 AND rating <= 5),
    feedback TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- ALTER TABLE vehicles ADD COLUMN transmission VARCHAR(20);
-- ALTER TABLE vehicles ADD COLUMN tyre_size VARCHAR(20);
-- ALTER TABLE vehicles ADD COLUMN color VARCHAR(30);
-- ALTER TABLE vehicles ADD COLUMN mileage INTEGER;
-- ALTER TABLE vehicles ADD COLUMN photos TEXT; -- We will store image paths as a string

-- Mechanic profile fields
ALTER TABLE users ADD COLUMN garage_name VARCHAR(100);
ALTER TABLE users ADD COLUMN garage_location VARCHAR(100);
ALTER TABLE users ADD COLUMN expertise TEXT;