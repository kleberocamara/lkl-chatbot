const fs = require('fs');

function svgIcon(size) {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">
  <rect width="${size}" height="${size}" fill="#1a237e" rx="${Math.round(size * 0.15)}"/>
  <text x="50%" y="55%" dominant-baseline="middle" text-anchor="middle"
        font-family="Arial" font-weight="bold" fill="white" font-size="${Math.round(size * 0.38)}">LKL</text>
</svg>`;
}

fs.writeFileSync('public/icons/icon-192.svg', svgIcon(192));
fs.writeFileSync('public/icons/icon-512.svg', svgIcon(512));
// Browsers also accept SVG referenced as PNG in manifests for our use case
fs.copyFileSync('public/icons/icon-192.svg', 'public/icons/icon-192.png');
fs.copyFileSync('public/icons/icon-512.svg', 'public/icons/icon-512.png');
console.log('Icons generated in public/icons/');
