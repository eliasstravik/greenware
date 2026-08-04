<p align="center"><img src="https://img.shields.io/badge/Greenware-Website%20form%20routing%20for%20Clay-2ea44f?style=flat-square&labelColor=24292f" alt="Greenware — Website form routing for Clay" /></p>

<h3 align="center">Route form leads through Clay without replacing your form or showing every visitor the same next step</h3>

<p align="center">Greenware lets you route each form submission through Clay while the visitor is still on your site when one static thank-you page cannot handle every lead, by attaching to the form you already use and rendering Clay's returned booking embed, redirect, message, or rejection in the browser.</p>

<p align="center"><img src="assets/greenware-form-routing.svg?v=1" width="88%" alt="A website form submits through Greenware to Clay and receives the next action Clay selected" /></p>

<p align="center"><a href="https://github.com/eliasstravik/greenware/blob/main/docs/getting-started.md"><img src="assets/buttons/deploy-greenware.svg" alt="Deploy Greenware" /></a>&nbsp;&nbsp;<a href="https://cal.com/stravik/demo?projects=Greenware" target="_blank" rel="noopener noreferrer"><img src="assets/buttons/book-a-demo.svg" alt="Book a demo" /></a></p>

<p align="center"><sub>✓&nbsp;100%&nbsp;free&nbsp;and&nbsp;open&nbsp;source &nbsp; ✓&nbsp;One&#8209;click&nbsp;Railway&nbsp;deploy &nbsp; ✓&nbsp;Keep&nbsp;your&nbsp;existing&nbsp;form</sub></p>

<p align="center"><small>⭐ Used by top GTM Engineers</small></p>

<br />

## Give every inbound lead the right next step while they are still on your site

Qualified buyers see a calendar where the form was. Other visitors receive the message, destination, or off-ramp meant for them before the context of the submission is lost.

## Choose between static thank-you pages, form-builder rules, custom backends — or the form you already have connected to Clay

| | **Greenware** | Static thank-you | Form-builder rules | Custom backend |
|---|:---:|:---:|:---:|:---:|
| **Free software** | ✅ | ✅ | ❌ | ✅ |
| **No backend code** | ✅ | ✅ | ✅ | ❌ |
| **Keeps the existing form** | ✅ | ✅ | ❌ | ✅ |
| **Routes with Clay enrichment** | ✅ | ❌ | ❌ | ✅ |
| **Different action per lead** | ✅ | ❌ | ✅ | ✅ |
| **Booking embed in the same form** | ✅ | ❌ | ✅ | ✅ |
| **Signed single-use callbacks** | ✅ | ❌ | ❌ | ✅ |
| **Tally and Typeform sessions** | ✅ | ❌ | ❌ | ✅ |
| **One-click Railway deployment** | ✅ | ❌ | ❌ | ❌ |

Keep the form your site already uses. Greenware manages the browser session, Clay makes the routing decision, and the visitor sees that action in place.

## Submit the form. Let Clay decide what the visitor sees next.

### 📈 Move qualified buyers straight to the calendar

Return an embed or redirect action from Clay and let the visitor book while the reason they submitted is still fresh.

### ⚡ Let Greenware manage the wait

Greenware creates the session, sends the lead to Clay, accepts the signed callback, and returns the selected action to the same browser.

### 💬 Show the next step inside the form

Replace the submitted form with a calendar, redirect, message, or polite rejection as soon as Clay's callback arrives.

## Route your first form through Clay in twenty minutes

<table>
<tr>
<td align="center" valign="top" width="33%"><h3>1️⃣</h3><b>Deploy Greenware</b><br /><sub>Use the Railway template, then add your Clay destination and allowed website origins.</sub></td>
<td align="center" valign="top" width="33%"><h3>2️⃣</h3><b>Return an action from Clay</b><br /><sub>Add a final HTTP API column that posts the selected action to Greenware's callback URL.</sub></td>
<td align="center" valign="top" width="33%"><h3>3️⃣</h3><b>Attach the form</b><br /><sub>Add the Greenware attributes and scripts, submit a lead, and watch the returned action replace the form.</sub></td>
</tr>
</table>

## Choose how to get started

<table>
<tr>
<td align="center" valign="top" width="50%"><h3>Self-serve</h3><sub>For GTM engineers who manage inbound routing</sub><br /><h2>Free</h2><div align="left">&nbsp;&nbsp;&nbsp;✓&nbsp; Custom forms, Tally, and Typeform<br />&nbsp;&nbsp;&nbsp;✓&nbsp; Multiple Clay destinations by form ID<br />&nbsp;&nbsp;&nbsp;✓&nbsp; Redirect, embed, message, and reject actions<br />&nbsp;&nbsp;&nbsp;✓&nbsp; Default UI or headless browser events<br />&nbsp;&nbsp;&nbsp;✓&nbsp; Signed callbacks, read tokens, and origin checks<br />&nbsp;&nbsp;&nbsp;✓&nbsp; Railway deployment with no database</div></td>
<td align="center" valign="top" width="50%"><h3>Done-with-you</h3><sub>Hands-on setup and ongoing support for your GTM team</sub><br /><h2>Let's talk</h2><div align="left">&nbsp;&nbsp;&nbsp;✓&nbsp; Everything in self-serve<br />&nbsp;&nbsp;&nbsp;✓&nbsp; Full setup and Railway deployment<br />&nbsp;&nbsp;&nbsp;✓&nbsp; Clay webhook and callback configuration<br />&nbsp;&nbsp;&nbsp;✓&nbsp; Greenware connected to your existing forms<br />&nbsp;&nbsp;&nbsp;✓&nbsp; Team rollout, training, and best practices<br />&nbsp;&nbsp;&nbsp;✓&nbsp; Ongoing maintenance and upgrades<br />&nbsp;&nbsp;&nbsp;✓&nbsp; Dedicated Slack channel support</div></td>
</tr>
<tr>
<td align="center"><a href="https://github.com/eliasstravik/greenware/blob/main/docs/getting-started.md"><img src="assets/buttons/deploy-greenware.svg" alt="Deploy Greenware" /></a></td>
<td align="center"><a href="https://cal.com/stravik/demo?projects=Greenware" target="_blank" rel="noopener noreferrer"><img src="assets/buttons/book-a-demo.svg" alt="Book a demo" /></a></td>
</tr>
</table>

## Get your questions answered

### Do I have to replace my current form?

No. Greenware can attach to a custom-coded form or coordinate an existing Tally or Typeform embed.

### Do I need to know how to code?

No code is needed to deploy the Railway template. A custom website form needs a small HTML snippet, while Tally and Typeform need hidden fields and a webhook URL.

### What can Clay show after someone submits?

Four actions: redirect to an HTTPS page, embed a supported HTTPS calendar or iframe, show a message with an optional CTA, or show a polite rejection with an optional off-ramp.

### Does Greenware store my form leads?

Greenware forwards the submission to Clay and keeps short-lived session state in memory. It does not use a durable database, and pending sessions disappear when the process restarts.

### Can one deployment route more than one form?

Yes. Map form IDs to named Clay webhook destinations and keep a default destination for unmatched IDs.

### Can I run several Greenware instances?

Not with the built-in store. Sessions and rate limits live in one process, so a multi-instance deployment would need shared storage.

### Are allowed origins the same as server authentication?

No. Origin checks protect browser integrations from accidental cross-site use, but non-browser clients can forge that header. Provider flows use per-session hidden credentials, and callbacks use signed expiring URLs.

### What does it cost?

Greenware is free and MIT licensed. You pay for the infrastructure, Clay, form provider, and enrichment services your workflow uses.

## Route your first form through Clay in twenty minutes

<p align="center">A working form can route through Clay after one deployment and one small embed. Greenware handles the browser round trip. You connect the form and choose what Clay returns.</p>

<p align="center"><a href="https://github.com/eliasstravik/greenware/blob/main/docs/getting-started.md"><img src="assets/buttons/deploy-greenware.svg" alt="Deploy Greenware" /></a>&nbsp;&nbsp;<a href="https://cal.com/stravik/demo?projects=Greenware" target="_blank" rel="noopener noreferrer"><img src="assets/buttons/book-a-demo.svg" alt="Book a demo" /></a></p>

<p align="center"><sub>✓&nbsp;100%&nbsp;free&nbsp;and&nbsp;open&nbsp;source &nbsp; ✓&nbsp;One&#8209;click&nbsp;Railway&nbsp;deploy &nbsp; ✓&nbsp;Keep&nbsp;your&nbsp;existing&nbsp;form</sub></p>

<p align="center"><small>⭐ Used by top GTM Engineers</small></p>
