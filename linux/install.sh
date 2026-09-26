#!/bin/sh
# Installs the Home Deck wake service in the Chrome OS Linux container and starts it automatically
# whenever Linux is running. Run once in the Terminal:
#   curl -fsSL https://raw.githubusercontent.com/Kriisshh/home-deck/main/linux/install.sh | sh
set -e
mkdir -p "$HOME/.local/bin" "$HOME/.config/systemd/user"
curl -fsSL https://raw.githubusercontent.com/Kriisshh/home-deck/main/linux/wol-server.py -o "$HOME/.local/bin/home-deck-wol.py"
cat > "$HOME/.config/systemd/user/home-deck-wol.service" <<EOF
[Unit]
Description=Home Deck wake service

[Service]
ExecStart=/usr/bin/python3 %h/.local/bin/home-deck-wol.py
Restart=on-failure

[Install]
WantedBy=default.target
EOF
systemctl --user daemon-reload
systemctl --user enable --now home-deck-wol.service
sleep 1
curl -fsS http://localhost:9009/ && echo && echo "Home Deck wake service is running."
