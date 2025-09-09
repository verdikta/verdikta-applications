# Set up required software. Run this only once.

# Update package list
sudo apt update

# Install Node.js and npm
sudo apt install nodejs npm

# Install server dependencies
cd server
npm install
cd ..

# Install client dependencies  
cd client
npm install
cd ..

