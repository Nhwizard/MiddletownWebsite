# Middletown Fellowship Church website

This repository contains the public church website and a password-protected PDF resource manager.

- Public website: `/`
- Public PDF library: `/resources/`
- Password-protected upload page: `/resources/admin/`
- Categories: Sermons, Bulletins, and Bible Passages
- Limits: five PDFs per category and 75 MB per PDF

The site is designed for Cloudflare Workers with Static Assets, D1, and R2. See [SETUP.md](SETUP.md) for the deployment instructions.

Never place the administrator password or session secret in this repository. Add both as encrypted Cloudflare secrets.
Cloudflare deployment directory: /middletown-resources-cloudflare
