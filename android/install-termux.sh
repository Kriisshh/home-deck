#!/data/data/com.termux/files/usr/bin/sh
# Turns an old Android phone into Home Deck's always-on Wake-on-LAN sender.
# Needs Termux + Termux:Boot (both from F-Droid). Run once inside Termux:
#   curl -fsSL https://raw.githubusercontent.com/Kriisshh/home-deck/main/android/install-termux.sh | sh
set -e
pkg install -y python curl >/dev/null
mkdir -p "$HOME/bin" "$HOME/.termux/boot"
curl -fsSL https://raw.githubusercontent.com/Kriisshh/home-deck/main/linux/wol-server.py -o "$HOME/bin/home-deck-wol.py"

# Start on every boot (Termux:Boot runs scripts in ~/.termux/boot). The wake lock stops Android
# from freezing Termux while the screen is off.
cat > "$HOME/.termux/boot/home-deck-wol.sh" <<'EOF'
#!/data/data/com.termux/files/usr/bin/sh
termux-wake-lock
pkill -f home-deck-wol.py 2>/dev/null
nohup python "$HOME/bin/home-deck-wol.py" >/dev/null 2>&1 &
EOF
chmod +x "$HOME/.termux/boot/home-deck-wol.sh"

# Start it now
sh "$HOME/.termux/boot/home-deck-wol.sh"
sleep 1
curl -fsS http://localhost:9009/ && echo
IP=$(ip -4 addr show wlan0 2>/dev/null | sed -n 's/.*inet \([0-9.]*\).*/\1/p' | head -n1)
echo "Home Deck wake service is running."
echo "Wake URL for Home Deck (home Wi-Fi): http://${IP:-<this phone's IP>}:9009/wake"
