import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { VitePWA } from "vite-plugin-pwa";
import path from "path";

export default defineConfig({
  plugins: [
    react(),
    VitePWA({
      registerType: "autoUpdate",
      manifest: {
        name: "Brook",
        short_name: "Brook",
        description: "Yohohoho! Personal music streaming player",
        theme_color: "#0a0a0a",
        background_color: "#0a0a0a",
        display: "standalone",
        orientation: "portrait",
        start_url: "/",
        icons: [
          { src: "/icon-192.png", sizes: "192x192", type: "image/png" },
          { src: "/icon-512.png", sizes: "512x512", type: "image/png" },
        ],
      },
      workbox: {
        globPatterns: ["**/*.{js,css,html,ico,png,svg,woff2}"],
        runtimeCaching: [
          {
            urlPattern: /\/rest\/getCoverArt/,
            handler: "CacheFirst",
            options: {
              cacheName: "cover-art",
              expiration: { maxEntries: 500, maxAgeSeconds: 30 * 24 * 60 * 60 },
              cacheableResponse: { statuses: [0, 200] },
            },
          },
          {
            urlPattern: /\/rest\/search3/,
            handler: "NetworkFirst",
            options: {
              cacheName: "song-list",
              expiration: { maxEntries: 20, maxAgeSeconds: 7 * 24 * 60 * 60 },
              cacheableResponse: { statuses: [0, 200] },
            },
          },
          {
            urlPattern: /\/automix\/tracks/,
            handler: "StaleWhileRevalidate",
            options: {
              cacheName: "automix-tracks",
              expiration: { maxEntries: 5, maxAgeSeconds: 24 * 60 * 60 },
              cacheableResponse: { statuses: [0, 200] },
            },
          },
          {
            urlPattern: /\/api\/analysis\.json/,
            handler: "StaleWhileRevalidate",
            options: {
              cacheName: "analysis-data",
              expiration: { maxEntries: 1, maxAgeSeconds: 7 * 24 * 60 * 60 },
              cacheableResponse: { statuses: [0, 200] },
            },
          },
        ],
      },
    }),
  ],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "src"),
    },
  },
  server: {
    port: 5173,
    proxy: {
      "/rest": {
        target: "https://deepakmusic.duckdns.org",
        changeOrigin: true,
        secure: true,
      },
      "/api": {
        target: "https://deepakmusic.duckdns.org",
        changeOrigin: true,
        secure: true,
      },
      "/automix": {
        target: "https://deepakmusic.duckdns.org",
        changeOrigin: true,
        secure: true,
      },
    },
  },
});
