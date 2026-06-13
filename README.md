# 🎵 Bar Jukebox

A production-ready music jukebox for bars and lounges with Spotify integration and user rate limiting.

## ✨ Features

- 🔍 **Spotify Search**: Real-time search of millions of songs
- 📱 **Mobile-Friendly**: Responsive design for phones and tablets
- ⏱️ **Rate Limiting**: 5-minute cooldown between song requests per user
- 🎯 **Shared Queue**: Everyone sees the same queue in real-time
- 🎨 **Modern UI**: Beautiful glassmorphism design with animations
- 🔊 **Audio Playback**: Uses Spotify 30-second previews  
- 📊 **Admin Dashboard**: Manage queue and view statistics
- 🌐 **WebSocket Updates**: Real-time queue sync across all devices

## 🚀 Quick Start

```bash
# Install dependencies
npm install

# Configure Spotify API (see SETUP.md)
cp .env.example .env
# Edit .env and add your Spotify credentials

# Start server
npm start

# Access at http://localhost:3000
```

📖 **Full setup instructions**: See [SETUP.md](./SETUP.md)

## 📋 Requirements

- Node.js 16+
- Spotify Developer Account (free)
- Network connection

## 🎯 Use Cases

Perfect for:
- Bars and lounges
- Parties and events
- Waiting rooms
- Co-working spaces
- Any public music space!

## 📸 Screenshots

[Your jukebox interface will appear here]

## 🛠️ Tech Stack

- **Frontend**: HTML, CSS, JavaScript
- **Backend**: Node.js + Express
- **Database**: SQLite
- **APIs**: Spotify Web API
- **Real-time**: WebSockets

## 📚 Documentation

- [Setup Guide](./SETUP.md) - Installation and deployment
- [API Documentation](#api-endpoints) - HTTP endpoints

## 🔐 Security

- Rate limiting per user (IP + cookie based)
- Admin routes protected by API key
- No user data collection
- Spotify OAuth handled securely

## 📝 License

MIT License - Feel free to use for your business!

---

**Made with ❤️ for bars and music lovers**
