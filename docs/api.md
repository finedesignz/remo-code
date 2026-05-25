---
title: remo-code hub v0.1.0
language_tabs:
  - shell: Shell
  - javascript: JavaScript
language_clients:
  - shell: ""
  - javascript: ""
toc_footers: []
includes: []
search: false
highlight_theme: darkula
headingLevel: 2

---

<!-- Generator: Widdershins v4.0.1 -->

<h1 id="remo-code-hub">remo-code hub v0.1.0</h1>

> Scroll down for code samples, example requests and responses. Select a language for code samples from the tabs above or the mobile navigation menu.

REST API for the remo-code hub. NOTE: Only the sample `/api/profile/cost-today` route is currently in the spec; the rest of the hub is plain Hono and will be migrated incrementally.

Base URLs:

* <a href="https://app.remo-code.com">https://app.remo-code.com</a>

* <a href="http://localhost:3040">http://localhost:3040</a>

# Authentication

- HTTP Authentication, scheme: bearer 

<h1 id="remo-code-hub-profile">profile</h1>

## Today's spend + daily cost cap

> Code samples

```shell
# You can also use wget
curl -X GET https://app.remo-code.com/api/profile/cost-today \
  -H 'Accept: application/json' \
  -H 'Authorization: Bearer {access-token}'

```

```javascript

const headers = {
  'Accept':'application/json',
  'Authorization':'Bearer {access-token}'
};

fetch('https://app.remo-code.com/api/profile/cost-today',
{
  method: 'GET',

  headers: headers
})
.then(function(res) {
    return res.json();
}).then(function(body) {
    console.log(body);
});

```

`GET /api/profile/cost-today`

Returns the authenticated user's scheduled-task spend so far today, their configured daily cap, and percent consumed. Used by the cost-cap UI banner.

> Example responses

> 200 Response

```json
{
  "cost_usd": 0,
  "cap_usd": 0,
  "percent": 0,
  "timezone": "string"
}
```

<h3 id="today's-spend-+-daily-cost-cap-responses">Responses</h3>

|Status|Meaning|Description|Schema|
|---|---|---|---|
|200|[OK](https://tools.ietf.org/html/rfc7231#section-6.3.1)|Cost snapshot for the current calendar day in the user's timezone|Inline|
|401|[Unauthorized](https://tools.ietf.org/html/rfc7235#section-3.1)|Missing or invalid JWT|Inline|

<h3 id="today's-spend-+-daily-cost-cap-responseschema">Response Schema</h3>

Status Code **200**

|Name|Type|Required|Restrictions|Description|
|---|---|---|---|---|
|» cost_usd|number|true|none|none|
|» cap_usd|number|true|none|none|
|» percent|number|true|none|none|
|» timezone|string|true|none|none|

Status Code **401**

|Name|Type|Required|Restrictions|Description|
|---|---|---|---|---|
|» error|string|true|none|none|

<aside class="warning">
To perform this operation, you must be authenticated by means of one of the following methods:
bearerAuth
</aside>

# Schemas

