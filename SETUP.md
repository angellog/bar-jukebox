# Bar Jukebox - Setup & Deployment Guide

## 🚀 Quick Start

### Prerequisites
- **Node.js** 16 or higher ([download here](https://nodejs.org/))
- **Spotify Developer Account** ([create here](https://developer.spotify.com/dashboard))

### Step 1: Install Dependencies

```bash
cd /Users/AngeloKiin/.gemini/antigravity/playground/obsidian-tyson
npm install
```

### Step 2: Get Spotify API Credentials

1. Go to https://developer.spotify.com/dashboard
2. Log in with your Spotify account
3. Click "**Create app**"
4. Fill in:
   - **App name**: "Bar Jukebox"
   - **App description**: "Music jukebox for my bar"
   - **Redirect URI**: http://localhost:3000/callback
5. Click "**Save**"
6. Click "**Settings**"
7. Copy your **Client ID** and **Client Secret**

### Step 3: Configure Environment

```bash
# Copy the example env file
cp .env.example .env

# Edit .env and add your credentials
# Use any text editor (nano, vim, VS Code, etc.)
nano .env
```

Add your Spotify credentials:
```env
SPOTIFY_CLIENT_ID=your_client_id_here
SPOTIFY_CLIENT_SECRET=your_client_secret_here
ADMIN_KEY=your_secret_password_here
```

### Step 4: Start the Server

```bash
npm start
```

You should see:
```
🎵 ================================
🎵 BAR JUKEBOX SERVER RUNNING
🎵 ================================
🌐 Server: http://localhost:3000
⏱️  Rate limit: 5 minutes
💾 Database: ./database/jukebox.db
🎧 Spotify: ✅ Configured
🎵 ================================
```

### Step 5: Access the Jukebox

Open your browser to: **http://localhost:3000**

---

## 📱 Mobile Access

To allow customers to access from their phones:

1. **Find your computer's IP address**:
   - Mac: System Preferences → Network
   - Windows: Open CMD and run `ipconfig`
   - Linux: Run `ifconfig` or `ip addr`

2. **Share the URL**: `http://YOUR_IP:3000`
   - Example: `http://192.168.1.100:3000`

3. **Make sure your computer and phones are on the same WiFi network**

---

## 🎛️ Admin Features

### Access Admin API

Use the admin key from your `.env` file in API requests:

```bash
# Clear the queue
curl -X POST http://localhost:3000/api/admin/clear-queue \
  -H "x-admin-key: your_secret_password_here"

# Reset all rate limits
curl -X POST http://localhost:3000/api/admin/reset-limits \
  -H "x-admin-key: your_secret_password_here"
```

### View Stats

```bash
curl http://localhost:3000/api/stats
```

---

## 🌐 Cloud Deployment

### Option 1: Heroku (Free Tier Available)

1. **Install Heroku CLI**: https://devcenter.heroku.com/articles/heroku-cli

2. **Login**:
```bash
heroku login
```

3. **Create app**:
```bash
heroku create your-bar-jukebox
```

4. **Set environment variables**:
```bash
heroku config:set SPOTIFY_CLIENT_ID=your_client_id
heroku config:set SPOTIFY_CLIENT_SECRET=your_client_secret
heroku config:set ADMIN_KEY=your_admin_key
```

5. **Deploy**:
```bash
git init
git add .
git commit -m "Initial commit"
git push heroku main
```

6. **Access**: `https://your-bar-jukebox.herokuapp.com`

### Option 2: DigitalOcean / VPS

1. **Create a droplet** (Ubuntu recommended)
2. **SSH into server**
3. **Install Node.js**:
```bash
curl -fsSL https://deb.nodesource.com/setup_18.x | sudo -E bash -
sudo apt-get install -y nodejs
```

4. **Clone/upload your code**
5. **Install dependencies**: `npm install`
6. **Use PM2 for process management**:
```bash
sudo npm install -g pm2
pm2 start server.js --name jukebox
pm2 save
pm2 startup
```

7. **Set up Nginx reverse proxy** for port 80/443

### Option 3: Raspberry Pi (Local Bar Server)

Perfect for running in your bar 24/7:

1. **Install Raspberry Pi OS**
2. **Install Node.js**: `sudo apt update && sudo apt install nodejs npm`
3. **Copy files to Pi**
4. **Run on startup**:
```bash
pm2 start server.js
pm2 save
pm2 startup
```

5. **Connect Pi to bar's sound system**
6. **Share WiFi URL with customers**

---

## 🔧 Configuration Options

Edit `.env` to customize:

```env
# Server port
PORT=3000

# Rate limiting (minutes between requests per user)
RATE_LIMIT_MINUTES=5

# Database location
DATABASE_PATH=./database/jukebox.db

# Admin API key
ADMIN_KEY=your_secret_key
```

---

## 🎵 How It Works

### For Customers:

1. Customer opens `http://YOUR_URL` on their phone
2. Searches for a song on Spotify
3. Clicks "Add to Queue"
4. Song is added to the shared queue
5. Must wait 5 minutes before adding another song

### For Bar Owner:

- Music plays through your computer/device connected to speakers
- Queue is managed automatically
- Use admin API to clear queue or reset limits
- View stats to see popular songs

---

## 🐛 Troubleshooting

### "Spotify API not configured"
- Make sure you added `SPOTIFY_CLIENT_ID` and `SPOTIFY_CLIENT_SECRET` to `.env`
- Restart the server after editing `.env`

### "Rate limit exceeded"
- User must wait 5 minutes between song requests
- As admin, you can reset limits: `POST /api/admin/reset-limits`

### Server not accessible from phones
- Make sure phones are on the same WiFi network
- Check firewall settings on your computer
- Use your computer's local IP address, not `localhost`

### Database errors
- Delete `database/jukebox.db` to reset
- Server will recreate the database on startup

---

## 📊 API Endpoints

### Public Endpoints

- `GET /api/search?q=query` - Search for songs
- `GET /api/queue` - Get current queue
- `POST /api/queue` - Add song to queue
- `DELETE /api/queue/:id` - Remove from queue
- `GET /api/now-playing` - Get currently playing song
- `GET /api/rate-limit` - Check user's rate limit status
- `GET /api/stats` - Get jukebox statistics

### Admin Endpoints (Require `x-admin-key` header)

- `POST /api/admin/clear-queue` - Clear entire queue
- `POST /api/admin/reset-limits` - Reset all user rate limits
- `POST /api/play-next` - Skip to next song

---

## 🎨 Customization

### Change Rate Limit

Edit `.env`:
```env
RATE_LIMIT_MINUTES=10  # Change from 5 to 10 minutes
```

### Custom Branding

Edit `index.html` and `styles.css` to match your bar's theme!

---

## 📞 Support

For setup help or issues:
- Check the troubleshooting section above
- Review server logs for error messages
- Make sure all dependencies are installed

---

## 🎉 You're Ready!

Your bar jukebox is now running! Customers can search Spotify and build a shared playlist. Enjoy! 🎵
