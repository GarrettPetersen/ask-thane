#!/usr/bin/env node

const STRIPE_API_BASE = "https://api.stripe.com/v1";

const catalogProduct = {
  name: "Thane Subscription",
  metadata: {
    thane_catalog: "true"
  }
};

const plans = [
  {
    key: "team",
    env: "STRIPE_PRICE_TEAM_MONTHLY",
    lookupKey: "thane_team_monthly_v1",
    nickname: "Team Monthly",
    amountCents: 9900,
    metadata: {
      tier: "team",
      included_users: "25",
      overage_user_usd: "3",
      included_ai_credit_usd: "20"
    }
  },
  {
    key: "growth",
    env: "STRIPE_PRICE_GROWTH_MONTHLY",
    lookupKey: "thane_growth_monthly_v1",
    nickname: "Growth Monthly",
    amountCents: 29900,
    metadata: {
      tier: "growth",
      included_users: "100",
      overage_user_usd: "2",
      included_ai_credit_usd: "120"
    }
  },
  {
    key: "scale",
    env: "STRIPE_PRICE_SCALE_MONTHLY",
    lookupKey: "thane_scale_monthly_v1",
    nickname: "Scale Monthly",
    amountCents: 69900,
    metadata: {
      tier: "scale",
      included_users: "300",
      overage_user_usd: "1.25",
      included_ai_credit_usd: "400"
    }
  },
  {
    key: "scale_plus",
    env: "STRIPE_PRICE_SCALE_PLUS_MONTHLY",
    lookupKey: "thane_scale_plus_monthly_v1",
    nickname: "Scale Plus Monthly",
    amountCents: 149900,
    metadata: {
      tier: "scale_plus",
      included_users: "1000",
      overage_user_usd: "1",
      included_ai_credit_usd: "1000"
    }
  }
];

function encodeForm(data) {
  const body = new URLSearchParams();
  for (const [key, value] of Object.entries(data)) {
    if (value === undefined || value === null) continue;
    body.set(key, String(value));
  }
  return body;
}

async function stripeRequest(apiKey, pathname, method = "GET", form = undefined) {
  const response = await fetch(`${STRIPE_API_BASE}${pathname}`, {
    method,
    headers: {
      Authorization: `Bearer ${apiKey}`,
      ...(form ? { "content-type": "application/x-www-form-urlencoded" } : {})
    },
    body: form ? encodeForm(form) : undefined
  });
  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Stripe request failed (${response.status}) ${pathname}: ${errorText}`);
  }
  return response.json();
}

async function findCatalogProduct(apiKey) {
  const list = await stripeRequest(apiKey, "/products?limit=100");
  const existing = (list.data ?? []).find((product) => {
    return product.name === catalogProduct.name && product.metadata?.thane_catalog === "true";
  });
  if (existing) return existing.id;
  const created = await stripeRequest(apiKey, "/products", "POST", {
    name: catalogProduct.name,
    "metadata[thane_catalog]": "true"
  });
  return created.id;
}

async function findOrCreatePlanPrice(apiKey, productId, plan) {
  const lookup = encodeURIComponent(plan.lookupKey);
  const existingList = await stripeRequest(apiKey, `/prices?lookup_keys[]=${lookup}&active=true&limit=3`);
  const existing = (existingList.data ?? [])[0];
  if (existing) return existing.id;

  const form = {
    currency: "usd",
    unit_amount: plan.amountCents,
    "recurring[interval]": "month",
    product: productId,
    nickname: plan.nickname,
    lookup_key: plan.lookupKey
  };
  for (const [key, value] of Object.entries(plan.metadata)) {
    form[`metadata[${key}]`] = value;
  }
  const created = await stripeRequest(apiKey, "/prices", "POST", form);
  return created.id;
}

async function main() {
  const apiKey = process.env.STRIPE_SECRET_KEY?.trim();
  if (!apiKey) {
    throw new Error("Missing STRIPE_SECRET_KEY in environment.");
  }

  const productId = await findCatalogProduct(apiKey);
  const output = {};
  for (const plan of plans) {
    output[plan.env] = await findOrCreatePlanPrice(apiKey, productId, plan);
  }

  console.log(`# Stripe catalog ready (product: ${productId})`);
  for (const [envKey, envValue] of Object.entries(output)) {
    console.log(`${envKey}=${envValue}`);
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
