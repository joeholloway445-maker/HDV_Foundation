# Turning on real creator payouts (Stripe setup, plain-English)

This is for the person running the server, not a developer. It walks through the one-time
setup so creators can actually get paid. Before you do this, payouts are safely turned off —
nobody can lose money, and nothing breaks if you skip this. Do it whenever you're ready.

You will need: a web browser, and about 15 minutes.

---

## What you're setting up

Two things, both inside your Stripe account:

1. **Stripe Identity** — checks that a creator is a real person (an ID check).
2. **Stripe Connect** — actually sends money to a creator's bank account.

The server already knows how to talk to both. You just need to flip them on in Stripe's
website and copy two secret codes into a file on your server.

---

## Step 1 — Create a Stripe account (skip if you already have one)

1. Go to **stripe.com** and click **Sign up**.
2. Enter your email, create a password, and confirm your email address.
3. That's it — you now have a Stripe account. You do not need to finish Stripe's full business
   verification to do the next steps in **test mode**, but you WILL need to finish it before
   real money can move (Stripe walks you through that when you're ready to go live).

---

## Step 2 — Turn on Stripe Connect

1. Log in to your Stripe Dashboard.
2. In the left sidebar, click **Connect**.
3. Click **Get started**.
4. When it asks what kind of accounts you're creating for your users, choose **Express**.
   (This is the "creator has a simple onboarding form, Stripe handles the rest" option — it's
   the right one here, don't pick anything else.)
5. Follow the on-screen prompts. You can accept the defaults for everything.

---

## Step 3 — Get your API key

1. In the left sidebar, click **Developers**, then **API keys**.
2. You'll see a **Secret key**. Click **Reveal test key** (or **Reveal live key** once you're
   ready for real money) and copy it. It starts with `sk_test_` or `sk_live_`.
3. Open the `.env` file on your server (see `deploy/HOSTINGER.md` if you're not sure where that
   is) and add this line, pasting in the key you just copied:

   ```
   STRIPE_SECRET_KEY="sk_test_the_key_you_copied"
   ```

**Start with the `sk_test_` key.** That lets you try everything out with fake money first. Swap
it for the `sk_live_` key later, once you've tested the whole flow and you're ready for real
payouts.

---

## Step 4 — Set up the webhook (this is how Stripe tells your server "this creator is verified")

1. In the left sidebar, click **Developers**, then **Webhooks**.
2. Click **Add endpoint**.
3. For **Endpoint URL**, type your website address followed by
   `/v1/creator/webhooks/stripe`. For example:

   ```
   https://your-domain.com/v1/creator/webhooks/stripe
   ```

4. Under **Select events to listen to**, search for and select:
   - `identity.verification_session.verified`
   - `identity.verification_session.requires_input`
   - `identity.verification_session.canceled`
   - `account.updated`

   (Tip: typing "identity.verification_session" into the search box will show all three at
   once — select all of them.)

5. Click **Add endpoint**.
6. On the page for the endpoint you just created, find **Signing secret** and click **Reveal**.
   Copy it — it starts with `whsec_`.
7. Add it to the same `.env` file:

   ```
   STRIPE_WEBHOOK_SECRET="whsec_the_secret_you_copied"
   ```

---

## Step 5 — Turn on Stripe Identity

1. In the left sidebar, click **Identity**.
2. Click **Get started**.
3. Follow the prompts. Brand-new Stripe accounts sometimes need a short manual approval from
   Stripe before Identity fully activates — if you see a message about that, it usually clears
   within a day or so. You don't need to do anything else while you wait.

---

## Step 6 — Restart the gateway

Your server needs to pick up the two new lines you added to `.env`. Restart it the same way you
normally would (for example, restarting the `hdv-gateway` service, or re-running
`npm run gateway` if you're running it directly).

When it starts up, look for this line in the log:

```
Creator payouts: LIVE (Stripe Identity + Connect configured)
```

If you see that, you're done — real payouts are now switched on. If you instead see:

```
Creator payouts: STUBBED (unconditionally blocked — set STRIPE_SECRET_KEY + STRIPE_WEBHOOK_SECRET to enable, ...)
```

...double-check that both lines are actually in your `.env` file, spelled exactly as shown
above, with no extra spaces, and that you restarted the server (not just saved the file).

---

## How to know it's really working

1. Have a test creator account request verification (`POST /v1/creator/verification`). They'll
   get a real link from Stripe to upload an ID photo and fill out their payout details.
2. Once they finish, Stripe sends your server the `identity.verification_session.verified`
   webhook automatically — you don't have to do anything for that part.
3. Only then can a payout to that creator succeed, and even then, your server double-checks
   directly with Stripe (not just its own memory) right before sending the money — see
   `creator/payout_stripe_live.ts` if you're curious how that safety check works.

---

## Good to know

- **One Stripe account runs the whole platform.** The same `STRIPE_SECRET_KEY` is also used by
  the (separate, unrelated) subscription-checkout feature — that's intentional, not a mistake.
- **Nothing is required to keep running the way it does today.** If you never do any of this,
  the server keeps working exactly as before — creators can apply and earn, they just can't be
  paid out yet. No behavior changes for anyone until you set both env vars.
- **Test mode is genuinely safe to play with.** An `sk_test_` key can never move real money, so
  feel free to click through all of the above and try a test payout before switching to
  `sk_live_`.
