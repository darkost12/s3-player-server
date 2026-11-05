docker run -d \
  --name player \
  --restart unless-stopped \
  -p 127.0.0.1:3000:3000 \
  --env-file .env \
  -v $(pwd)/users.json:/app/users.json \
  player-server:latest
