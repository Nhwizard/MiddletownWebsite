# Setup instructions

These files extend the existing Middletown Fellowship Church website. The public pages remain available to everyone, while only a person with the shared administrator password can upload or delete PDFs.

## 1. Put the files in GitHub

Upload the **contents** of this folder to the root of the existing `Nhwizard/MiddletownWebsite` repository. Keep the folder structure exactly as shown:

```text
MiddletownWebsite/
├── .assetsignore
├── _headers
├── index.html
├── middletown-fellowship-church.jpg
├── package.json
├── README.md
├── resources/
│   ├── index.html
│   └── admin/
│       └── index.html
├── schema.sql
├── SETUP.md
├── worker.js
└── wrangler.jsonc
```

On GitHub, use **Add file → Upload files** and commit the files directly to `main`. If GitHub asks whether to replace `index.html`, replace it with the new one. Do not upload the outer `middletown-resources-cloudflare` folder as an extra directory.

The following files are essential:

- `resources/index.html` is the public PDF library.
- `resources/admin/index.html` is the private upload page.
- `worker.js` handles passwords, uploads, viewing, downloading, and deletion.
- `wrangler.jsonc` tells Cloudflare how to deploy the site and provision storage.
- `.assetsignore` prevents source and configuration files from becoming public website files.

## 2. Let Cloudflare deploy the GitHub commit

The existing Cloudflare Worker should detect the commit automatically. In **Workers & Pages → middletownwebsite → Deployments**, wait for the new deployment to complete.

Use these build settings if Cloudflare asks:

- Build command: leave blank (or use `npm run check`)
- Deploy command: `npx wrangler deploy`
- Root directory: `/`
- Production branch: `main`

The first deployment uses Cloudflare's automatic resource provisioning to create:

- a D1 database connected as `DB` for PDF titles and details;
- an R2 bucket connected as `PDFS` for the PDF files.

The database tables are created automatically the first time the resource library is opened. `schema.sql` is included only as a readable backup of that structure; you should not normally need to run it.

## 3. Add the two encrypted secrets

After the new deployment, open **Workers & Pages → middletownwebsite → Settings → Variables and Secrets**. Add both values as **Secret** values, not ordinary visible text variables:

1. `ADMIN_PASSWORD` — the shared password used at `/resources/admin/`.
2. `SESSION_SECRET` — a separate long random value used to secure sign-in cookies.

Use a strong password for `ADMIN_PASSWORD`. Anyone who knows it can upload and delete resources.

For `SESSION_SECRET`, use a password manager to generate at least 32 random characters. You can also open Terminal on the Mac and run:

```sh
openssl rand -base64 48
```

Copy the result into the Cloudflare secret field. Do not use the same value as the administrator password, and do not put either value in GitHub.

Saving secrets may create a new deployment. If Cloudflare asks which environment to use, choose **Production**.

## 4. Confirm the Cloudflare bindings

In the Worker's **Bindings** or **Settings** page, confirm these exact binding names exist:

- D1 database: `DB`
- R2 bucket: `PDFS`

If automatic provisioning did not create one, add it manually with the exact binding name above. The underlying database or bucket can have any sensible resource name, such as `middletown-resources` and `middletown-resources-pdfs`.

## 5. Test the finished site

Open these addresses:

- `https://middletownfellowship.org/`
- `https://middletownfellowship.org/resources/`
- `https://middletownfellowship.org/resources/admin/`

Sign in on the administrator page and upload one small PDF as a test. Confirm that its **View PDF** and **Download PDF** buttons both work on the public resource page. Then delete the test if it is not intended to remain public.

## Limits and expected cost

- Each section permits five PDFs, for a total of 15.
- Each PDF may be up to 75 MB.
- The absolute maximum would be about 1.1 GB, well below R2's 10 GB-month free allowance.
- R2 internet egress is free. Viewing and downloading use R2 Class B operations, which also have a large monthly free allowance.
- D1 stores only small text records, so this use is far below its free allowances.
- Workers handles the application on Cloudflare; no computer or private server needs to stay turned on.

Cloudflare pricing and limits can change. Current references:

- R2 pricing: https://developers.cloudflare.com/r2/pricing/
- Workers pricing: https://developers.cloudflare.com/workers/platform/pricing/
- D1 pricing: https://developers.cloudflare.com/d1/platform/pricing/
- Worker request-size limits: https://developers.cloudflare.com/workers/platform/limits/

## Everyday use

Go to `/resources/admin/`, enter the shared password, choose a section, enter a title and optional details, select a PDF, and choose **Upload PDF**. When a section already has five items, delete an older PDF before adding another.

Signing in lasts for up to eight hours on that browser. Use **Sign Out** when working on a shared computer.
