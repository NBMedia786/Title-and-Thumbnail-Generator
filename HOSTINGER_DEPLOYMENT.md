# Hostinger Deployment Guide

## Overview

This guide covers deploying the Title & Thumbnail Generator to Hostinger's Node.js hosting. The main challenge is handling large video file uploads (up to 2GB) which requires specific server configuration.

## Prerequisites

- Hostinger VPS or Business hosting with Node.js support
- SSH access to your server
- PM2 process manager (usually pre-installed)
- Node.js 18+ installed

## Deployment Steps

### 1. Upload Your Code

```bash
# Via Git (recommended)
cd ~/public_html
git clone <your-repo-url> tt-generator
cd tt-generator

# Or via FTP/SFTP
# Upload all files to ~/public_html/tt-generator/
```

### 2. Install Dependencies

```bash
cd ~/public_html/tt-generator
npm install
```

### 3. Configure Environment Variables

Create or edit `.env` file:

```bash
nano .env
```

Ensure these critical settings are present:

```env
GOOGLE_API_KEY=your_api_key_here
MODEL=gemini-2.5-pro
PORT=3002

# CRITICAL: Large file upload settings
MULTER_MAX_FILE_SIZE=2147483648          # 2GB

# CRITICAL: Server timeouts for large uploads
SERVER_REQUEST_TIMEOUT_MS=36000000       # 10 hours
SERVER_HEADERS_TIMEOUT_MS=1800000        # 30 minutes
SERVER_KEEPALIVE_TIMEOUT_MS=7200000      # 2 hours
```

### 4. Create Uploads Directory

```bash
mkdir -p public/uploads
chmod 755 public/uploads
```

Verify write permissions:
```bash
touch public/uploads/test.txt
rm public/uploads/test.txt
# If this fails, you have permission issues
```

### 5. Configure Nginx (CRITICAL for large uploads)

Hostinger typically uses Nginx as a reverse proxy. You need to increase upload limits.

**Option A: Via .htaccess (if using Apache)**

Create `.htaccess` in your project root:

```apache
# Increase upload limits
LimitRequestBody 2147483648
php_value upload_max_filesize 2048M
php_value post_max_size 2048M
```

**Option B: Via Nginx config (requires SSH/root access)**

Edit your site's Nginx configuration (usually in `/etc/nginx/sites-available/`):

```nginx
server {
    # ... existing config ...
    
    location / {
        # CRITICAL: Increase client body size for large uploads
        client_max_body_size 2G;
        
        # CRITICAL: Increase timeouts
        proxy_read_timeout 3600s;
        proxy_send_timeout 3600s;
        proxy_connect_timeout 600s;
        
        # Proxy to Node.js
        proxy_pass http://localhost:3002;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_cache_bypass $http_upgrade;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    }
}
```

Reload Nginx:
```bash
sudo nginx -t
sudo systemctl reload nginx
```

### 6. Start with PM2

```bash
# Start the application
pm2 start server.js --name tt-generator

# Save PM2 configuration
pm2 save

# Enable PM2 to start on boot
pm2 startup
```

### 7. Verify Deployment

Check the health endpoint:
```bash
curl http://localhost:3002/api/health
```

Expected response:
```json
{
  "status": "ok",
  "uploads": {
    "writable": true,
    "maxFileSize": 2147483648
  },
  "goldStandards": {
    "json": true,
    "csv": true,
    "keywords": true
  }
}
```

## Troubleshooting HTTP 502 Errors

### Check PM2 Logs

```bash
pm2 logs tt-generator --lines 100
```

Look for:
- `[UPLOADS] ERROR: Cannot write to uploads directory` → Permission issue
- `Files API upload failed` → API key or network issue
- `LIMIT_FILE_SIZE` → File too large (check nginx config)

### Check Nginx Error Logs

```bash
tail -f /var/log/nginx/error.log
```

Common errors:
- `client intended to send too large body` → Need to increase `client_max_body_size`
- `upstream timed out` → Need to increase proxy timeouts

### Verify Upload Directory

```bash
ls -la public/uploads
# Should show: drwxr-xr-x with your user as owner

# Test write access
touch public/uploads/.test && rm public/uploads/.test
```

### Test with Small File First

Before uploading large files, test with a small video (~10MB) to isolate the issue.

### Check Server Resources

```bash
# Check disk space
df -h

# Check memory
free -h

# Check if Node.js process is running
pm2 status
```

## Common Issues and Solutions

### Issue: "413 Request Entity Too Large"

**Cause:** Nginx `client_max_body_size` is too small

**Solution:** Increase in Nginx config (see step 5)

### Issue: "502 Bad Gateway" during upload

**Cause:** Node.js process crashed or timeout

**Solutions:**
1. Check PM2 logs: `pm2 logs tt-generator`
2. Increase server timeouts in `.env`
3. Restart PM2: `pm2 restart tt-generator`

### Issue: "Upload failed: EACCES"

**Cause:** No write permission to uploads directory

**Solution:**
```bash
chmod 755 public/uploads
chown -R $USER:$USER public/uploads
```

### Issue: "File not ACTIVE" timeout

**Cause:** Gemini Files API is slow to process large files

**Solution:** Already configured in `.env` with 10-hour timeout. If still failing, check API quota limits.

## Performance Optimization

### Enable Gzip Compression

In Nginx config:
```nginx
gzip on;
gzip_types text/plain text/css application/json application/javascript;
```

### Monitor Memory Usage

```bash
pm2 monit
```

If memory usage is high, consider:
- Reducing `HISTORY_LIMIT_BYTES` in `.env`
- Implementing file cleanup cron job

### Cleanup Old Uploads

Create a cron job to delete old uploads:

```bash
crontab -e
```

Add:
```cron
# Delete uploads older than 7 days at 2 AM daily
0 2 * * * find ~/public_html/tt-generator/public/uploads -type f -mtime +7 -delete
```

## Security Considerations

1. **API Key Protection:** Never commit `.env` to Git
2. **File Type Validation:** Already implemented (video files only)
3. **Rate Limiting:** Consider adding nginx rate limiting for production
4. **HTTPS:** Ensure SSL certificate is active on Hostinger

## Monitoring

### Set Up PM2 Monitoring

```bash
pm2 install pm2-logrotate
pm2 set pm2-logrotate:max_size 10M
pm2 set pm2-logrotate:retain 7
```

### Check Application Health

Create a monitoring script:

```bash
#!/bin/bash
# check-health.sh
response=$(curl -s http://localhost:3002/api/health)
if [[ $response == *"\"status\":\"ok\""* ]]; then
    echo "✓ Application is healthy"
else
    echo "✗ Application is unhealthy"
    pm2 restart tt-generator
fi
```

Run every 5 minutes via cron:
```cron
*/5 * * * * /path/to/check-health.sh
```

## Support

If issues persist:
1. Check PM2 logs: `pm2 logs tt-generator --lines 200`
2. Check Nginx logs: `tail -100 /var/log/nginx/error.log`
3. Verify health endpoint: `curl http://localhost:3002/api/health`
4. Test with small file first to isolate the problem
