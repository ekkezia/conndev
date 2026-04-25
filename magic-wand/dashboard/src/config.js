// export const REACT_APP_SERVER_URL = process.env.REACT_APP_SERVER_URL || 'https://imu-remote.onrender.com';
// export const REACT_APP_SERVER_URL = process.env.REACT_APP_SERVER_URL || '104.236.108.119:4000';
export const REACT_APP_SERVER_URL = process.env.REACT_APP_SERVER_URL || 'http://localhost:4000';
export const MAPILLARY_TOKEN = process.env.REACT_APP_MAPILLARY_TOKEN || '';
// Canvas aspect ratio (width : 1). Canvas is letterboxed inside the viewport.
export const CANVAS_RATIO = parseFloat(process.env.REACT_APP_CANVAS_RATIO) || 5.21;

// Map start location (lat/lng)
export const MAP_START = { lat: 40.6925, lng: -73.9872 };

// Sound effects
export const SFX = {
  perfect: '/effects/perfect.mp3',
  click:   '/effects/perfect.mp3', // replace with /effects/click.mp3
  starHit: '/effects/perfect.mp3', // replace with /effects/star-hit.mp3
  magic:   '/effects/game-bonus.mp3',
};
