#!/usr/bin/env node
// Hashes a password and stores it in users.json under the given name (used only for server logs).
// Usage: node add-user.js <name> <password>

require('dotenv').config()
const bcrypt = require('bcrypt')
const fs = require('fs')
const path = require('path')

const [, , name, password] = process.argv
if (!name || !password) {
  console.error('Usage: node add-user.js <name> <password>')
  process.exit(1)
}

const saltRounds = parseInt(process.env.SALT_ROUNDS || '12', 10)
const file = path.join(__dirname, 'users.json')
const users = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf-8')) : {}

bcrypt.hash(password, saltRounds).then((hash) => {
  users[name] = hash
  fs.writeFileSync(file, JSON.stringify(users, null, 2))
  console.log(`User "${name}" saved to users.json`)
})
