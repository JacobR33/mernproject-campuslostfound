# Instructor demo

Run the server commands below in SSH as `gianni`. The public website is
**https://lostfound.jacobreyes1234.me**. WSL and Windows PowerShell commands are
explicitly labelled. Do the one-time steps before the presentation.

## One-time preparation

1. Commit and push this revision from **local WSL**, in the project folder:

   ```bash
   git add demo.sh DEMO.md server/scripts/demo.cjs client/src/App.jsx client/tests/entry.test.jsx client/tests/e2e/app.spec.js
   git commit -m "Add instructor demo helper and login-first homepage"
   git push origin Frontend
   ```

   Then on the **Droplet**:

   ```bash
   cd ~/mernproject-campuslostfound
   git pull --ff-only origin Frontend
   ```

2. This revision makes `/` redirect signed-out visitors to Login. Rebuild the
   frontend **in local WSL**, not on the small Droplet:

   ```bash
   cd /mnt/e/VS_Code_Files/POOSD/MERN-Campus-LF/mernproject-campuslostfound
   npm run build
   ```

3. Upload from **Windows PowerShell**, using the SSH key/options you normally use:

   ```powershell
   scp -r "E:\VS_Code_Files\POOSD\MERN-Campus-LF\mernproject-campuslostfound\client\dist\." gianni@137.184.27.69:~/campus-frontend/
   ```

4. Back in **server SSH**, publish the uploaded build:

   ```bash
   sudo cp -r ~/campus-frontend/. /var/www/campus-lost-found/
   sudo chmod -R a+rX /var/www/campus-lost-found
   ```

5. Stop the old backend with **Ctrl+C in the SSH terminal running it**. Then, in
   the project root, install the background service:

   ```bash
   cd ~/mernproject-campuslostfound
   bash demo.sh setup
   ```

   This installs `campus-lost-found-demo.service` for the current user, enables it
   at boot, and starts it. It uses the existing `server/.env`, dependencies,
   Nginx configuration, and TLS certificate. It does not install packages, change
   your secrets, migrate the database, replace Nginx, or kill an existing process.
   If port 4000 is occupied, it asks you to stop the old backend first.

   The existing classroom `.env` should have `PORT=4000`,
   `CLIENT_ORIGIN=https://lostfound.jacobreyes1234.me`, and
   `TRUST_PROXY=127.0.0.1`. Keep the database URI and application secrets private.
   Leave file-based mail as configured for this demo; this script does not turn
   the classroom deployment into a production deployment.

## On presentation day

In **server SSH**:

```bash
cd ~/mernproject-campuslostfound
bash demo.sh
```

This starts the service if needed and checks the local API, HTTP-to-HTTPS
redirect, HTTPS React page, public API forwarding, and Atlas replica-set support.
It uses normal certificate validation. The health check alone does not establish
database readiness, so Atlas is checked separately. It does not automatically
perform the browser walkthrough or certify each rubric item.

Open a **private/incognito browser window** so an old session does not skip Login.
Use a new test account you control with an `@ucf.edu` login address and a unique
password of at least 12 characters. The UCF email field is the application's
username/login; there is no separate username field. The display name is entered
separately.

| Rubric item                               | What to demonstrate                                                                                                                                                                     |
| ----------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Domain name — 10%                         | Enter `https://lostfound.jacobreyes1234.me/`, showing the hostname in the address bar.                                                                                                  |
| HTTPS — 10%                               | Show the HTTPS URL and the browser's secure connection/certificate information.                                                                                                         |
| Initial Login page — 10%                  | In a fresh private window, `/` redirects to `/login`. If Browse appears first, the updated build has not been uploaded.                                                                 |
| Registration option — 10%                 | Click **Create an account** on Login.                                                                                                                                                   |
| Registration fields — 20%                 | Submit a display name, UCF email as the login, and password. Explain that verification is an additional step.                                                                           |
| Correct credentials and interaction — 20% | Verify, sign in, and show Browse. Enter a search and click Search; switch between All posts, Found items, and Lost items. Even with no matching posts, the filters and results respond. |
| Incorrect credentials — 20%               | Sign out. Enter the same login with an incorrect password once. Show the generic sign-in failure alert on the Login page.                                                               |

The app presents failed login as an error alert on the Login page, rather than
navigating to a separate error URL. The rubric says "error page"; confirm with
your instructor whether this presentation meets their interpretation. The error
does not disclose whether the account exists.

## Verification during the demo

After registering, wait a few seconds for the mail worker, then run in **server SSH**:

```bash
bash demo.sh link
```

Enter the registered email address when prompted. The script selects only that
recipient's newest verification email and prints its complete link. In Windows
Terminal, **Ctrl+click** the URL; if it opens outside your private window, copy it
into the private window instead. Click **Verify email**, then sign in there.

Keep the link and password off shared screenshots. These JSON messages are a
classroom mailbox, not real email delivery. They stay outside `/var/www` and must
not be publicly served. The script does not bypass verification or change users.
If a link has expired, was already used, or was replaced by another request, use
**Resend verification email**, wait a few seconds, then rerun `bash demo.sh link`.
With SMTP configured, use the actual recipient inbox instead.

## Troubleshooting

```bash
bash demo.sh check
bash demo.sh status
bash demo.sh logs
```

- `Unit ... not found`: complete the one-time `bash demo.sh setup` step.
- `bad unit file setting`: run
  `sudo systemd-analyze verify /etc/systemd/system/campus-lost-found-demo.service`.
  An older helper incorrectly quoted `WorkingDirectory`. Use the corrected
  helper from this revision before rerunning setup; `WorkingDirectory` should
  contain the absolute server directory without surrounding quotes.
- `Port 4000 is already in use`: stop the old foreground backend, then rerun setup.
- `This request was not allowed`: check `CLIENT_ORIGIN` and restart the service
  after changing `.env`: `sudo systemctl restart campus-lost-found-demo`.
- Atlas check fails: confirm Atlas permits the Droplet's public IP and that the
  private connection string has valid credentials. Do not post the URI.
- No mail found: make sure registration used an `@ucf.edu` address, request a new
  verification link, wait a few seconds, and check backend logs.
- `Killed` or repeated restarts: the 512 MB Droplet may be running out of memory.
  Atlas offloads the database, but this script cannot guarantee available RAM.

To stop the backend after the demo:

```bash
bash demo.sh stop
```

It remains enabled for the next reboot. To also disable automatic startup:

```bash
sudo systemctl disable --now campus-lost-found-demo.service
```
