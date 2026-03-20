@echo off
title LanLink Tactical Server
color 0A

echo =========================================================
echo       LANLINK TACTICAL NETWORK - AUTOMATED LAUNCHER
echo =========================================================
echo.
echo [1] Configuring Windows Firewall...
:: Silently open the necessary ports required by server.js
netsh advfirewall firewall add rule name="LanLink-HTTP" dir=in action=allow protocol=tcp localport=8080 >nul 2>&1
netsh advfirewall firewall add rule name="LanLink-HTTPS" dir=in action=allow protocol=tcp localport=8443 >nul 2>&1
netsh advfirewall firewall add rule name="LanLink-WS" dir=in action=allow protocol=tcp localport=8765 >nul 2>&1
netsh advfirewall firewall add rule name="LanLink-STUN" dir=in action=allow protocol=udp localport=3478 >nul 2>&1
echo     ✓ Firewall ports opened successfully.

echo.
echo [2] Launching Secure Server...
echo     Keep this black window open to maintain the network!
echo.
:: Run the portable node.exe with server.js
node.exe server.js

pause