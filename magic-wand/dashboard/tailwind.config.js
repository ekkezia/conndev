/** @type {import('tailwindcss').Config} */
module.exports = {
  content: [
    "./src/**/*.{js,jsx,ts,tsx}",
    "./public/index.html"
  ],
  theme: {
    extend: {
      colors: {
        'pink-doll': '#ff4fa3',
        'pink-hot-ribbon': '#ff1e7a',
        'pink-rose-punch': '#d93a6a',
        'orange-peach-glow': '#ff9a5a',
        'orange-tangerine-pop': '#ff6a2d',
        'orange-mango-shine': '#ffb43b',
        'cream-soda': '#fff1dd',
        'warm-blush': '#ffd4b8',
        'berry-shadow': '#7a1f3a',
        'cola-brown': '#4b1f1c',
      },
    },
  },
  plugins: [],
}
