CREATE TABLE users (
  id serial PRIMARY KEY,
  email text NOT NULL, -- deliberately NO index or unique
  password_hash text NOT NULL,
  name text
);

CREATE TABLE projects (
  id serial PRIMARY KEY,
  owner_id int NOT NULL REFERENCES users(id),
  name text NOT NULL,
  created_at timestamptz DEFAULT now()
);
