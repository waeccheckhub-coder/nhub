/** @type {import('tailwindcss').Config} */
module.exports = {
  content: [
    "./pages/**/*.{js,ts,jsx,tsx}",
    "./components/**/*.{js,ts,jsx,tsx}",
  ],
  theme: {
    extend: {
      colors: {
        neonBlue: '#00f3ff',
        neonPink: '#ff00ff',
        neonGreen: '#00ff41',
      },
    },
  },
  plugins: [],
}
