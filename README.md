# Options Extrinsic Value Analyzer

Rank option strikes by extrinsic value efficiency for premium selling. Uses real market data from Yahoo Finance — no Black-Scholes modeling.

## What It Does

- Fetches live option chain data (bid, ask, Greeks, IV, OI) from Yahoo Finance
- Computes **Extrinsic = Mid Price − Intrinsic** from real market prices
- Ranks strikes by **Efficiency = Extrinsic ÷ DTE ÷ |Delta|**
- Visualizes premium structure, efficiency scores, and Greeks profiles

## Prerequisites

- [Node.js](https://nodejs.org/) version 16 or higher (includes npm)
- A [GitHub](https://github.com/) account
- [Git](https://git-scm.com/) installed on your machine

## Quick Start (Local Development)

```bash
# 1. Clone or download this repo
git clone https://github.com/YOUR_USERNAME/options-extrinsic-analyzer.git
cd options-extrinsic-analyzer

# 2. Install dependencies
npm install

# 3. Start the dev server
npm start
```

This opens `http://localhost:3000` in your browser with hot-reloading.

## Deploy to GitHub Pages (Free Hosting)

### Step 1: Create a GitHub Repository

1. Go to https://github.com/new
2. Name it `options-extrinsic-analyzer` (or whatever you prefer)
3. Leave it **public**
4. Do NOT initialize with README (we already have one)
5. Click **Create repository**

### Step 2: Push Your Code

```bash
# In your project folder:
git init
git add .
git commit -m "Initial commit - Options Extrinsic Value Analyzer"
git branch -M main
git remote add origin https://github.com/YOUR_USERNAME/options-extrinsic-analyzer.git
git push -u origin main
```

### Step 3: Update homepage in package.json

Open `package.json` and change the `homepage` field:

```json
"homepage": "https://YOUR_USERNAME.github.io/options-extrinsic-analyzer"
```

### Step 4: Deploy

```bash
npm run deploy
```

This builds the app and pushes it to a `gh-pages` branch. Your site will be live at:

```
https://YOUR_USERNAME.github.io/options-extrinsic-analyzer
```

### Step 5: Enable GitHub Pages (first time only)

1. Go to your repo on GitHub → **Settings** → **Pages**
2. Under "Source", select branch: **gh-pages**, folder: **/ (root)**
3. Click **Save**
4. Wait 1-2 minutes, then visit your URL

## Updating the App

After making changes:

```bash
git add .
git commit -m "Description of changes"
git push
npm run deploy
```

## Tech Stack

- React 18
- Recharts (charts)
- Yahoo Finance API (via CORS proxies)
- GitHub Pages (hosting)

## License

MIT
