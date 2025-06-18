# Deployment

This guide covers deploying the AI Jury System frontend application in various environments, from local development to production deployment.

## Prerequisites

### Development Environment
- **Node.js**: Version 16.x or higher
- **npm**: Version 8.x or higher (comes with Node.js)
- **Git**: For version control and deployment
- **MetaMask**: For blockchain interaction testing

### Production Environment
- **Web Server**: Apache, Nginx, or CDN service
- **SSL Certificate**: HTTPS required for MetaMask integration
- **Domain**: Custom domain for production deployment
- **Backend Server**: Node.js server for IPFS and API services

## Local Development Setup

### 1. Clone Repository
```bash
git clone https://github.com/verdikta/verdikta-applications.git
cd verdikta-applications/example-frontend
```

### 2. Install Dependencies

#### Frontend Dependencies
```bash
cd client
npm install
```

#### Backend Dependencies
```bash
cd ../server
npm install
```

### 3. Environment Configuration

#### Frontend Environment Variables
Create `.env` file in the `client` directory:
```env
REACT_APP_SERVER_URL=http://localhost:5000
REACT_APP_CONTRACT_ADDRESSES=0x1234...
REACT_APP_CONTRACT_NAMES=Local Test Contract
REACT_APP_CONTRACT_CLASSES=128
```

#### Backend Environment Variables
Create `.env` file in the `server` directory:
```env
PORT=5000
IPFS_API_URL=http://localhost:5001
CORS_ORIGIN=http://localhost:3000
```

### 4. Start Development Servers

#### Start Backend Server
```bash
cd server
npm start
```

#### Start Frontend Development Server
```bash
cd client
npm start
```

The application will be available at `http://localhost:3000`.

## Production Build

### 1. Build Frontend Application
```bash
cd client
npm run build
```

This creates an optimized production build in the `build/` directory.

### 2. Test Production Build Locally
```bash
# Install serve globally
npm install -g serve

# Serve the production build
serve -s build -l 3000
```

### 3. Build Optimization Verification
- Check bundle size and performance
- Verify all environment variables are properly set
- Test functionality with production build

## Deployment Options

### Option 1: Static Hosting (Vercel, Netlify)

#### Vercel Deployment
1. **Connect Repository**: Link your GitHub repository to Vercel
2. **Configure Build Settings**:
   - Build Command: `cd client && npm run build`
   - Output Directory: `client/build`
   - Install Command: `cd client && npm install`

3. **Environment Variables**: Set in Vercel dashboard:
   - `REACT_APP_SERVER_URL`: Your backend server URL
   - `REACT_APP_CONTRACT_ADDRESSES`: Production contract addresses
   - `REACT_APP_CONTRACT_NAMES`: Contract display names
   - `REACT_APP_CONTRACT_CLASSES`: Contract classification numbers

4. **Deploy**: Automatic deployment on git push

#### Netlify Deployment
1. **Build Settings**:
   - Base Directory: `client`
   - Build Command: `npm run build`
   - Publish Directory: `client/build`

2. **Environment Variables**: Configure in site settings
3. **Deploy**: Connect repository for automatic deployments

### Option 2: Traditional Web Server

#### Nginx Configuration
```nginx
server {
    listen 80;
    server_name your-domain.com;
    
    # Redirect HTTP to HTTPS
    return 301 https://$server_name$request_uri;
}

server {
    listen 443 ssl http2;
    server_name your-domain.com;
    
    ssl_certificate /path/to/certificate.crt;
    ssl_certificate_key /path/to/private.key;
    
    root /var/www/ai-jury-frontend;
    index index.html;
    
    # Handle React Router
    location / {
        try_files $uri $uri/ /index.html;
    }
    
    # API proxy to backend
    location /api/ {
        proxy_pass http://localhost:5000;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
    }
    
    # Gzip compression
    gzip on;
    gzip_types text/css application/javascript application/json;
    
    # Caching headers
    location /static/ {
        expires 1y;
        add_header Cache-Control "public, immutable";
    }
}
```

#### Apache Configuration
```apache
<VirtualHost *:443>
    ServerName your-domain.com
    DocumentRoot /var/www/ai-jury-frontend
    
    SSLEngine on
    SSLCertificateFile /path/to/certificate.crt
    SSLCertificateKeyFile /path/to/private.key
    
    # Enable rewrite module for React Router
    RewriteEngine On
    RewriteCond %{REQUEST_FILENAME} !-f
    RewriteCond %{REQUEST_FILENAME} !-d
    RewriteRule . /index.html [L]
    
    # Proxy API requests to backend
    ProxyPreserveHost On
    ProxyPass /api/ http://localhost:5000/api/
    ProxyPassReverse /api/ http://localhost:5000/api/
    
    # Compression
    LoadModule deflate_module modules/mod_deflate.so
    <Location />
        SetOutputFilter DEFLATE
    </Location>
</VirtualHost>
```

### Option 3: Docker Deployment

#### Dockerfile for Frontend
```dockerfile
# Build stage
FROM node:16-alpine AS build

WORKDIR /app
COPY client/package*.json ./
RUN npm ci --only=production

COPY client/ ./
RUN npm run build

# Production stage
FROM nginx:alpine

COPY --from=build /app/build /usr/share/nginx/html
COPY nginx.conf /etc/nginx/nginx.conf

EXPOSE 80
CMD ["nginx", "-g", "daemon off;"]
```

#### Docker Compose
```yaml
version: '3.8'

services:
  frontend:
    build: .
    ports:
      - "80:80"
    environment:
      - REACT_APP_SERVER_URL=http://backend:5000
    depends_on:
      - backend

  backend:
    build: ./server
    ports:
      - "5000:5000"
    environment:
      - PORT=5000
      - IPFS_API_URL=http://ipfs:5001
    depends_on:
      - ipfs

  ipfs:
    image: ipfs/go-ipfs:latest
    ports:
      - "4001:4001"
      - "5001:5001"
      - "8080:8080"
    volumes:
      - ipfs_data:/data/ipfs

volumes:
  ipfs_data:
```

## Backend Server Deployment

### Node.js Backend Setup

#### Production Dependencies
```bash
cd server
npm install --production
```

#### Process Management with PM2
```bash
# Install PM2 globally
npm install -g pm2

# Start server with PM2
pm2 start server.js --name "ai-jury-backend"

# Configure auto-restart
pm2 startup
pm2 save
```

#### Environment Configuration
```env
NODE_ENV=production
PORT=5000
IPFS_API_URL=http://localhost:5001
CORS_ORIGIN=https://your-frontend-domain.com
```

### IPFS Node Setup

#### Local IPFS Node
```bash
# Install IPFS
wget https://dist.ipfs.io/go-ipfs/v0.13.0/go-ipfs_v0.13.0_linux-amd64.tar.gz
tar -xvzf go-ipfs_v0.13.0_linux-amd64.tar.gz
cd go-ipfs
sudo bash install.sh

# Initialize and start IPFS
ipfs init
ipfs daemon
```

#### IPFS Configuration
```bash
# Allow API access from backend
ipfs config --json API.HTTPHeaders.Access-Control-Allow-Origin '["http://localhost:5000"]'
ipfs config --json API.HTTPHeaders.Access-Control-Allow-Methods '["PUT", "POST"]'
```

## Environment-Specific Configuration

### Development Environment
- **Hot Reloading**: Automatic refresh on code changes
- **Debug Logging**: Verbose console output
- **Source Maps**: For debugging minified code
- **Mock Data**: Test contracts and sample data

### Staging Environment
- **Production Build**: Optimized and minified
- **Test Contracts**: Dedicated testing smart contracts
- **Limited Logging**: Error and warning logs only
- **Real APIs**: Production-like service integration

### Production Environment
- **Optimized Build**: Maximum performance optimization
- **Production Contracts**: Live smart contracts
- **Minimal Logging**: Error tracking only
- **CDN Integration**: Static asset delivery optimization
- **Monitoring**: Health checks and performance tracking

## Security Configuration

### HTTPS Setup
```bash
# Using Let's Encrypt with Certbot
sudo apt install certbot python3-certbot-nginx
sudo certbot --nginx -d your-domain.com
```

### Content Security Policy
```html
<meta http-equiv="Content-Security-Policy" content="
    default-src 'self';
    script-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net;
    style-src 'self' 'unsafe-inline';
    connect-src 'self' https://base-sepolia.infura.io https://ipfs.io;
    img-src 'self' data: https:;
">
```

### Environment Variables Security
- Never commit `.env` files to version control
- Use secure environment variable management
- Rotate API keys regularly
- Limit contract permissions to minimum required

## Performance Optimization

### Build Optimization
```json
{
  "scripts": {
    "build": "GENERATE_SOURCEMAP=false react-scripts build"
  }
}
```

### Code Splitting
```javascript
// Lazy load components
const Results = lazy(() => import('./pages/Results'));
const QueryDefinition = lazy(() => import('./pages/QueryDefinition'));
```

### Bundle Analysis
```bash
# Install bundle analyzer
npm install --save-dev webpack-bundle-analyzer

# Analyze bundle
npm run build
npx webpack-bundle-analyzer build/static/js/*.js
```

## Monitoring and Maintenance

### Health Checks
```javascript
// Add health check endpoint
app.get('/health', (req, res) => {
  res.json({
    status: 'healthy',
    timestamp: new Date().toISOString(),
    uptime: process.uptime()
  });
});
```

### Log Management
```bash
# PM2 log management
pm2 logs ai-jury-backend
pm2 flush  # Clear logs
```

### Backup Strategy
- **Code**: Regular git commits and repository backups
- **Configuration**: Environment variable backups
- **Logs**: Regular log rotation and archival
- **Database**: If using persistent storage, regular backups

## Troubleshooting

### Common Deployment Issues

#### Build Failures
- **Memory Issues**: Increase Node.js memory limit
- **Dependency Conflicts**: Clear `node_modules` and reinstall
- **Environment Variables**: Verify all required variables are set

#### Runtime Errors
- **CORS Issues**: Configure backend CORS settings
- **MetaMask Connection**: Ensure HTTPS in production
- **IPFS Access**: Verify IPFS node connectivity

#### Performance Issues
- **Bundle Size**: Analyze and optimize bundle
- **Memory Leaks**: Monitor Node.js memory usage
- **Network Latency**: Use CDN for static assets

### Debugging Production Issues
```bash
# Check server logs
pm2 logs ai-jury-backend --lines 100

# Monitor server resources
pm2 monit

# Check IPFS status
ipfs swarm peers
ipfs repo stat
```

## Scaling Considerations

### Horizontal Scaling
- **Load Balancers**: Distribute traffic across multiple instances
- **CDN**: Global content delivery for better performance
- **Database Sharding**: If using persistent storage

### Vertical Scaling
- **Server Resources**: Increase CPU and memory as needed
- **IPFS Storage**: Monitor and manage IPFS repository size
- **Network Bandwidth**: Ensure adequate bandwidth for IPFS traffic

### Auto-scaling
- **Container Orchestration**: Kubernetes for automatic scaling
- **Serverless**: Consider serverless functions for API endpoints
- **Monitoring**: Implement metrics-based auto-scaling 