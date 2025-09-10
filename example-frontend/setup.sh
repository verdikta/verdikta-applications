# Set up required software. Run this only once.
# After running this, you still must set up .env in server/ and client/

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

