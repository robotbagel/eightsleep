# Eight Sleep Control App

This WebApp is an alternative interface to control any Eight Sleep mattress. It gives the user the ability to schedule the temperature throughout the night without the need for an Eight Sleep subscription. This is achieved by not using Eight Sleep's "Smart Scheduling" feature, but instead running a recurring script every 30 minutes to adjust the temperature based on the schedule. If you share your mattress, both of you will be able to log in to your accounts and control your side of the mattress.

<img src="eightsleep-nosub-app.png" alt="Eight Sleep No-Subscription App" width="500">

## How to use this app yourself

In the following, I will explain how to self-host this webapp on Vercel so that you can control it from anywhere. The setup will not generate any costs. It should take about 15 minutes to complete, **no coding skills required**.

1. Set up a (free) GitHub Account
2. Set up a (free) Vercel Account using your GitHub Account as the Login Method
3. On this GitHub Page, click the "Fork" Button to make a copy of this repository, and follow the steps, renaming the project to whatever you want.
4. Go to your Vercel Dashboard and create a new Project
5. You are now in the process of creating a new project on Vercel.
    - In "Import Git Repository" select your forked project
    - At "Configure Project" select the "Environment Variables" Section and create the three needed Environment Variables (`CRON_SECRET`, `JWT_SECRET`, `APPROVED_EMAILS`) and set the two Secrets to a random string of your choice. [E.g. use this site](https://it-tools.tech/token-generator). Save the **CRON_SECRET**, you will need it in a moment. 
    - Set APPROVED_EMAILS to a comma-separated list of emails that are allowed to log in to the app. This is so that no one except you (and potentially your partner) can log in to the app.
    - Continue and the project will be built. **The first build will fail, which is expected**.
    - Click "Go to Project"
6. Two more settings in Vercel
    - In the project, click the "Settings" Tab
    - In the "General" tab under "Build & Development Settings" override the "Build Command" to `npm run build && npm run db:push` and **press the save button**.
    - In the "Deployment Protection" Tab, disable "Vercel Authentication" at the very top.
7. Add database to project
    - In the project, click the "Storage" Tab
    - Click "Create Database"
    - Select "Postgres", then "accept", then "create", then "connect" (all defaults are fine in between)
8. Rebuild project
    - In the project, click the "Deployments" Tab.
    - Select the 3 dots next to the previously failed build and click "Redeploy"
9. Test the app
    - Go to the main "Project" Tab
    - On the top right click "Visit"
    - Welcome to your new App! Save the URL, we will need it in a second. Also save it as a bookmark for future use.
    - Try to log in to the app with your Eight Sleep Login. This will work now.
    - Important: **Set up a Temperature profile now!** or the next step will fail. You can change it later.
10. Activate the recurring Update of the Mattress
    - Go to [cron-job.org](https://cron-job.org/en/) and set up a free account
    - Create a new "Cron Job"
    - Title can be anything
    - URL: `https://YOUR_VERCEL_URL/api/temperatureCron` e.g. `https://eightsleep-nosub-app-efwfwfwf-aerotows-projects.vercel.app/api/temperatureCron`
    - Set it to every 30 minutes
    - Under the "Advanced" Tab add a "Header"
        - Key: `Authorization`
        - Value: `Bearer YOUR_CRON_SECRET` (note the space after Bearer, include the word Bearer and the space!)
    - Click "TEST RUN", then "START TEST RUN" and make sure that the "TEST RUN STATUS" is "200 OK"
    - Click "Save"


Enjoy! That's it!

## AI Autopilot (optional)

The app includes a self-correcting temperature optimizer that replaces the subscription "Autopilot". All temperatures are shown in °C (bed water temperature, 13-44°C) instead of Eight Sleep's raw -100..+100 levels. It has two layers:

**Nightly optimizer.** Every morning it reads last night's sleep data from your pod (sleep stages, toss-and-turns, bed and room temperature, heart rate, HRV), combines it with research-backed thermoregulation rules and the running history of which temperature configuration produced your best sleep scores, and recommends adjusted temperatures for your three stages with plain-language reasoning. It works like an experiment loop: it keeps what improved your score, reverts automatically to the best-known configuration when two nights in a row regress, and declares the profile converged when scores plateau at your best. You can apply recommendations with one tap or let them auto-apply.

**Live night-time tuning.** During the night, on every 30-minute cron tick, it looks at the last 45 minutes of the in-progress session. If you are tossing or your heart rate is elevated while the bed is warm, it cools by 0.5°C; if you are restless while the bed is cold, it warms by 0.5°C (never more than 1.5°C drift per night, reset each morning). Every nudge is logged with its reason in the app, and persistent nudges get folded into the next morning's schedule recommendation.

Both layers run from the same 30-minute cron job you already set up — nothing extra to schedule.

To enable it:

1. Get a free Gemini API key from [Google AI Studio](https://aistudio.google.com/apikey).
2. In your Vercel project settings, add an Environment Variable `GEMINI_API_KEY` with that key and redeploy.
3. In the app, open the "AI Autopilot" card, switch on "Enable daily AI recommendations" (and optionally "Live night-time tuning"), and describe your sleep preference (e.g. "I sleep hot, prioritize deep sleep").

Settings:

- **Auto-apply without asking**: morning recommendations update your temperature profile immediately. Off means they wait as "pending" until you tap Apply.
- **Max change per day** caps how far the optimizer may move any stage in one day (default 2°C).
- **Optimize Now** generates a recommendation on demand.
- The optional `GEMINI_MODEL` environment variable overrides the model (default `gemini-3.7-flash`). The daily call costs a fraction of a cent.

The rules encode findings from sleep-thermoregulation research: mild bed warmth at bedtime shortens sleep onset; heat above the comfort band suppresses deep sleep and REM, while mild within-comfort warming can deepen sleep and prevent early-morning waking ([Raymann, Swaab & Van Someren, Brain 2008](https://academic.oup.com/brain/article/131/2/500/407617)); slightly warmer late-night temperatures support REM; and stage-aware adjustment measurably improves deep sleep, HRV, and resting heart rate ([Eight Sleep / SLEEP 2025 abstract](https://academic.oup.com/sleep/article/48/Supplement_1/A202/8135278)).

## How to Upgrade from an older Version?

Check the [Release Notes](https://github.com/aerotow/eightsleep-nosub-app/releases) to see what changed. I will include steps you have to do there to upgrade. After you have read the notes there and made potential changes, make sure to go to your GitHub fork and sync to the latest commit of this repository. It's just one click at the top.

## Credits

- Thanks to @lukas-clarke for his Home Assistant package eight_sleep and pyEight which gave me the idea of the possibility to use the API of the app.
- Thanks also to @mezz64 for the initial work on his pyEight package.
- Thanks to the @t3-oss team for the great T3 boilerplate on which this codebase is based.

## Disclaimer

### IMPORTANT: Please read this disclaimer carefully before using this software.

This project is an unofficial, independent effort and is not affiliated with, endorsed by, or supported by Eight Sleep, Inc. in any way. The software provided here interacts with Eight Sleep's systems through reverse-engineered methods and is not using any officially sanctioned API.

**Key Points:**

- **Unofficial Project**: This is not an official Eight Sleep product. Use it at your own risk.
- **No Warranty**: This software is provided "as is", without warranty of any kind, express or implied.

**Potential Risks:**

- Using this software may violate Eight Sleep's Terms of Service.
- It could potentially lead to account suspension or other actions by Eight Sleep.
- Future updates to Eight Sleep's systems may break this software's functionality.

**Data Security**: While we strive to handle data securely, we cannot guarantee the same level of security as Eight Sleep's official apps. Use caution when handling sensitive information.

**Legal Considerations**: The legality of reverse engineering and using unofficial APIs can vary by jurisdiction. Ensure you understand the legal implications in your area.

**No Liability**: The developers of this project are not responsible for any damages or losses, including but not limited to, damages related to data loss, service interruption, or account issues.

**Use Responsibly**: This tool is intended for personal use only. Do not use it to access or modify data of Eight Sleep accounts you do not own or have explicit permission to manage.

By using this software, you acknowledge that you have read this disclaimer, understand its contents, and agree to use the software at your own risk. If you do not agree with these terms, do not use this software.

Always prioritize the official Eight Sleep app for critical functions and data management related to your Eight Sleep products.