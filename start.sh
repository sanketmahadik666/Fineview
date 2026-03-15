#!/bin/bash

# Kill any existing mongod processes
pkill -f mongod 2>/dev/null || true
sleep 1

# Start MongoDB in the background
mkdir -p /home/runner/workspace/data/db
mongod --dbpath /home/runner/workspace/data/db --bind_ip 127.0.0.1 --port 27017 &
MONGO_PID=$!
echo "MongoDB started with PID $MONGO_PID"

# Wait for MongoDB to be ready by watching for port
echo "Waiting for MongoDB to start..."
for i in $(seq 1 30); do
  if bash -c "echo > /dev/tcp/127.0.0.1/27017" 2>/dev/null; then
    echo "MongoDB is ready."
    break
  fi
  sleep 1
  echo "Waiting... attempt $i"
done

# Start backend server in background
cd /home/runner/workspace/server
node server.js &
BACKEND_PID=$!
echo "Backend started with PID $BACKEND_PID"

# Wait a moment for backend to initialize
sleep 2

# Start frontend (blocks, this is what keeps the workflow alive on port 5000)
cd /home/runner/workspace/client
npm run dev
