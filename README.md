
# 📡 LanLink: The Air-Gapped Tactical Mesh

![Version](https://img.shields.io/badge/version-9.0.0-blue.svg)
![License](https://img.shields.io/badge/license-MIT-green.svg)
![Zero Dependencies](https://img.shields.io/badge/cloud_dependencies-ZERO-red.svg)
![Node.js](https://img.shields.io/badge/node-%3E%3D18.0.0-brightgreen.svg)

**Zero Internet. Zero Infrastructure. Zero Trust.** LanLink is a hyper-resilient, 100% offline communication mesh engineered for austere environments. Designed for tactical command posts, disaster recovery zones, and deep subterranean operations, LanLink provides instantaneous High-Definition P2P video, voice, and heavy file-sharing without a single packet of data ever touching the public internet.



## ⚡ The Mission
Commercial tools like WhatsApp, Slack, and Teams instantly fail when the cellular grid goes down because they rely on external DNS and cloud servers. 

LanLink solves the "Contested Comms" problem. By plugging a single laptop into a commercial Wi-Fi router, you can blanket a perimeter in a secure communication bubble in under 60 seconds. No client-side installation is required—troops and technicians simply connect to the Wi-Fi, open their browser, and are instantly meshed.

## 🛠 Core Capabilities

* **🌐 100% Offline Operation:** No external APIs, no cloud routing, no DNS lookups.
* **🎥 Peer-to-Peer WebRTC:** Direct device-to-device encrypted voice and video calls. Video streams bypass the server entirely to eliminate bandwidth bottlenecks.
* **🧠 Built-in Offline STUN Server:** Natively runs an RFC 5389 STUN server (UDP 3478) to shatter NAT firewalls and allow WebRTC to function seamlessly across complex, multi-router topologies.
* **📁 Heavy Tactical Payload Transfer:** Drag-and-drop secure file transfers up to 500MB per file.
* **📱 Service Worker Resilience:** Even if a user locks their phone or backgrounds the browser, the native Service Worker maintains a persistent background connection, buffering messages to IndexedDB and issuing native push notifications.
* **💻 Tactical Screen Sharing:** Hijack a 1-on-1 video call to broadcast live drone feeds, digitized personnel records, or tactical maps.

## 🏗 Architecture & Tech Stack

LanLink operates on a highly optimized, dual-protocol Node.js backend:
* **Signaling & Text:** WebSockets (Port 8765/8443) handle ultra-low latency text routing and peer discovery.
* **Media & WebRTC:** Handled entirely client-side via browser APIs.
* **Background Sync:** Managed by `sw.js` using IndexedDB for offline buffering.



## 🚀 Quick Start Deployment (60 Seconds)

### Prerequisites
* Node.js v18+ installed on the host machine.
* A local Wi-Fi router (no internet cable required).

### Installation
1. Clone the repository:
   ```bash
   git clone [https://github.com/yourusername/lanlink-tactical.git](https://github.com/yourusername/lanlink-tactical.git)
   cd lanlink-tactical
   ```
2. Install the sole dependency (WebSocket engine):
   ```bash
   npm install ws
   ```
3. Start the server:
   ```bash
   node server.js
   ```
4. The terminal will output the local IP addresses. Have any device on the network open `http://<HOST_IP>:8080` in Chrome, Safari, or Edge.

### 🔒 Enabling Voice & Video (HTTPS Requirement)
Modern browsers strictly block microphone and camera access on plain `http` connections. To unlock Voice, Video, and Screen Sharing, you must generate local SSL certificates.

Run this command inside the project folder:
```bash
openssl req -x509 -newkey rsa:2048 -keyout key.pem -out cert.pem -days 365 -nodes -subj "/CN=LanLink"
```
Restart `server.js`. The server will automatically detect the certificates and upgrade the entire mesh to secure HTTPS/WSS on port 8443.

## 🌍 Primary Use Cases
* **Defense & Military:** Forward Operating Bases (FOBs), Naval vessels, and SCIFs.
* **Disaster Response:** NDRF/FEMA basecamps during hurricanes, earthquakes, or cellular blackouts.
* **Industrial Edge:** Deep-sea oil rigs, underground mining operations, and remote construction sites.

## 🛡️ License & Contributing
This "Community Edition" of LanLink is open-source under the MIT License. 

Pull requests are highly encouraged, especially for features involving decentralized DHT discovery, hardware-watchdog integration, and UI localization.

---
*Built for the edge. The cloud is a luxury; LanLink is a necessity.*
```

***
