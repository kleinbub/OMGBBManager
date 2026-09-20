@echo off
rem Start OMGBBManager and open it in the default browser.
cd /d "%~dp0"
start "" http://localhost:4173
node server.js
