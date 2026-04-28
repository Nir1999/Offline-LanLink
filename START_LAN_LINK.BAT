@echo off
title LanLink Tactical Server
color 0A

echo =========================================================
echo       LANLINK TACTICAL NETWORK - AUTOMATED LAUNCHER
echo =========================================================
echo.
echo [1] Configuring Windows Firewall...
:: Open the fallback TCP ranges used by server.js plus fixed STUN
netsh advfirewall firewall add rule name="LanLink-HTTP-Range" dir=in action=allow protocol=tcp localport=8080-8100 >nul 2>&1
netsh advfirewall firewall add rule name="LanLink-HTTPS-Range" dir=in action=allow protocol=tcp localport=8443-8463 >nul 2>&1
netsh advfirewall firewall add rule name="LanLink-STUN" dir=in action=allow protocol=udp localport=3478 >nul 2>&1
echo     ✓ Firewall rules applied for LanLink fallback ports.

echo.
echo [2] Launching Secure Server...
echo     Keep this black window open to maintain the network!
echo.
:: Run the portable node.exe with server.js
node.exe server.js

pause
