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

REST API for the remo-code hub. Routes are migrated to the OpenAPI surface incrementally; currently covers `/api/profile/cost-today` and `/api/profile/license`. The rest of the hub is plain Hono.

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

Returns the authenticated user's real accumulated token spend so far today (the same figure the daily cost cap enforces — interactive, Telegram, webhook and scheduled-run turns), their configured daily cap, and percent consumed. Used by the cost-cap UI banner.

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

## License status for the authenticated user

> Code samples

```shell
# You can also use wget
curl -X GET https://app.remo-code.com/api/profile/license \
  -H 'Accept: application/json' \
  -H 'Authorization: Bearer {access-token}'

```

```javascript

const headers = {
  'Accept':'application/json',
  'Authorization':'Bearer {access-token}'
};

fetch('https://app.remo-code.com/api/profile/license',
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

`GET /api/profile/license`

Returns the user's current license status (mirrored from Titanium Licensing), license id, and the timestamp of the last sync. Used by the web UI's license badge. Auth-gated; NOT license-gated — needed even when the license is expired so the user can see why.

> Example responses

> 200 Response

```json
{
  "status": "active",
  "license_id": "string",
  "checked_at": "string"
}
```

<h3 id="license-status-for-the-authenticated-user-responses">Responses</h3>

|Status|Meaning|Description|Schema|
|---|---|---|---|
|200|[OK](https://tools.ietf.org/html/rfc7231#section-6.3.1)|License snapshot|Inline|
|401|[Unauthorized](https://tools.ietf.org/html/rfc7235#section-3.1)|Missing or invalid session|Inline|

<h3 id="license-status-for-the-authenticated-user-responseschema">Response Schema</h3>

Status Code **200**

|Name|Type|Required|Restrictions|Description|
|---|---|---|---|---|
|» status|string|true|none|none|
|» license_id|string¦null|true|none|none|
|» checked_at|string¦null|true|none|none|

#### Enumerated Values

|Property|Value|
|---|---|
|status|active|
|status|expired|
|status|suspended|
|status|banned|
|status|none|
|status|unknown|

Status Code **401**

|Name|Type|Required|Restrictions|Description|
|---|---|---|---|---|
|» error|string|true|none|none|

<aside class="warning">
To perform this operation, you must be authenticated by means of one of the following methods:
bearerAuth
</aside>

<h1 id="remo-code-hub-sessions">Sessions</h1>

## List local folders awaiting GitHub classification

> Code samples

```shell
# You can also use wget
curl -X GET https://app.remo-code.com/api/sessions/pending-prompts \
  -H 'Accept: application/json' \
  -H 'Authorization: Bearer {access-token}'

```

```javascript

const headers = {
  'Accept':'application/json',
  'Authorization':'Bearer {access-token}'
};

fetch('https://app.remo-code.com/api/sessions/pending-prompts',
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

`GET /api/sessions/pending-prompts`

Returns folders the user's agent/supervisor has reported as not-yet-on-GitHub (or not a git repo at all) and that the user has NOT dismissed. Drives the 'Needs attention' section of the sidebar. See Phase 08 ARCHITECTURE §6.

> Example responses

> 200 Response

```json
{
  "pending": [
    {
      "hostname": "string",
      "project_dir": "string",
      "is_git_repo": true,
      "first_seen_at": "string",
      "last_seen_at": "string"
    }
  ]
}
```

<h3 id="list-local-folders-awaiting-github-classification-responses">Responses</h3>

|Status|Meaning|Description|Schema|
|---|---|---|---|
|200|[OK](https://tools.ietf.org/html/rfc7231#section-6.3.1)|Pending local repos for the authenticated user|Inline|
|401|[Unauthorized](https://tools.ietf.org/html/rfc7235#section-3.1)|Missing or invalid JWT|Inline|

<h3 id="list-local-folders-awaiting-github-classification-responseschema">Response Schema</h3>

Status Code **200**

|Name|Type|Required|Restrictions|Description|
|---|---|---|---|---|
|» pending|[object]|true|none|none|
|»» hostname|string|true|none|none|
|»» project_dir|string|true|none|none|
|»» is_git_repo|boolean|true|none|none|
|»» first_seen_at|string|true|none|none|
|»» last_seen_at|string|true|none|none|

Status Code **401**

|Name|Type|Required|Restrictions|Description|
|---|---|---|---|---|
|» error|string|true|none|none|

<aside class="warning">
To perform this operation, you must be authenticated by means of one of the following methods:
bearerAuth
</aside>

## Dismiss a pending local folder

> Code samples

```shell
# You can also use wget
curl -X POST https://app.remo-code.com/api/sessions/dismiss-local \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json' \
  -H 'Authorization: Bearer {access-token}'

```

```javascript
const inputBody = '{
  "hostname": "string",
  "project_dir": "string"
}';
const headers = {
  'Content-Type':'application/json',
  'Accept':'application/json',
  'Authorization':'Bearer {access-token}'
};

fetch('https://app.remo-code.com/api/sessions/dismiss-local',
{
  method: 'POST',
  body: inputBody,
  headers: headers
})
.then(function(res) {
    return res.json();
}).then(function(body) {
    console.log(body);
});

```

`POST /api/sessions/dismiss-local`

Records a user dismissal for `(hostname, project_dir)` and removes the row from `pending_local_repos`. Idempotent — repeated calls return 200 without duplicating dismissals.

> Body parameter

```json
{
  "hostname": "string",
  "project_dir": "string"
}
```

<h3 id="dismiss-a-pending-local-folder-parameters">Parameters</h3>

|Name|In|Type|Required|Description|
|---|---|---|---|---|
|body|body|object|false|none|
|» hostname|body|string|true|none|
|» project_dir|body|string|true|none|

> Example responses

> 200 Response

```json
{
  "dismissed": true
}
```

<h3 id="dismiss-a-pending-local-folder-responses">Responses</h3>

|Status|Meaning|Description|Schema|
|---|---|---|---|
|200|[OK](https://tools.ietf.org/html/rfc7231#section-6.3.1)|Dismissed|Inline|
|400|[Bad Request](https://tools.ietf.org/html/rfc7231#section-6.5.1)|Invalid body|Inline|
|401|[Unauthorized](https://tools.ietf.org/html/rfc7235#section-3.1)|Missing or invalid JWT|Inline|

<h3 id="dismiss-a-pending-local-folder-responseschema">Response Schema</h3>

Status Code **200**

|Name|Type|Required|Restrictions|Description|
|---|---|---|---|---|
|» dismissed|boolean|true|none|none|

#### Enumerated Values

|Property|Value|
|---|---|
|dismissed|true|

Status Code **400**

|Name|Type|Required|Restrictions|Description|
|---|---|---|---|---|
|» error|string|true|none|none|

Status Code **401**

|Name|Type|Required|Restrictions|Description|
|---|---|---|---|---|
|» error|string|true|none|none|

<aside class="warning">
To perform this operation, you must be authenticated by means of one of the following methods:
bearerAuth
</aside>

<h1 id="remo-code-hub-tasks">Tasks</h1>

## Predefined GSD scheduled-task templates

> Code samples

```shell
# You can also use wget
curl -X GET https://app.remo-code.com/api/tasks/templates \
  -H 'Accept: application/json' \
  -H 'Authorization: Bearer {access-token}'

```

```javascript

const headers = {
  'Accept':'application/json',
  'Authorization':'Bearer {access-token}'
};

fetch('https://app.remo-code.com/api/tasks/templates',
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

`GET /api/tasks/templates`

Returns the static, read-only catalog of GSD task templates (Run dev, Audit, Review PRs, Plan). A template pre-fills a normal scheduled-task CREATE — it is sugar over the existing payload (no new table). Each carries an injected GSD slash prompt, default cadence, guardrails (non-bypassable cost cap, plan-first), and default post-run actions.

> Example responses

> 200 Response

```json
{
  "templates": [
    {
      "id": "gsd_run",
      "label": "string",
      "description": "string",
      "promptTemplate": "string",
      "taskType": "dev",
      "defaultCron": "string",
      "cadenceLabel": "string",
      "requiredInputs": [
        "target_session"
      ],
      "guardrails": {
        "planFirst": true,
        "autoMerge": true,
        "inheritCostCap": true
      },
      "defaultPostRunActions": [
        {
          "type": "notify_telegram",
          "on": "success",
          "config": {
            "property1": null,
            "property2": null
          }
        }
      ],
      "category": "gsd"
    }
  ]
}
```

<h3 id="predefined-gsd-scheduled-task-templates-responses">Responses</h3>

|Status|Meaning|Description|Schema|
|---|---|---|---|
|200|[OK](https://tools.ietf.org/html/rfc7231#section-6.3.1)|GSD template catalog|Inline|
|401|[Unauthorized](https://tools.ietf.org/html/rfc7235#section-3.1)|Missing or invalid session|Inline|

<h3 id="predefined-gsd-scheduled-task-templates-responseschema">Response Schema</h3>

Status Code **200**

|Name|Type|Required|Restrictions|Description|
|---|---|---|---|---|
|» templates|[object]|true|none|none|
|»» id|string|true|none|none|
|»» label|string|true|none|none|
|»» description|string|true|none|none|
|»» promptTemplate|string|true|none|none|
|»» taskType|string|true|none|none|
|»» defaultCron|string|true|none|none|
|»» cadenceLabel|string|true|none|none|
|»» requiredInputs|[string]|true|none|none|
|»» guardrails|object|true|none|none|
|»»» planFirst|boolean|true|none|none|
|»»» autoMerge|boolean|true|none|none|
|»»» inheritCostCap|boolean|true|none|none|
|»» defaultPostRunActions|[object]|true|none|none|
|»»» type|string|true|none|none|
|»»» on|string|true|none|none|
|»»» config|object|true|none|none|
|»»»» **additionalProperties**|any|false|none|none|
|»» category|string|true|none|none|

#### Enumerated Values

|Property|Value|
|---|---|
|id|gsd_run|
|id|gsd_audit|
|id|gsd_review|
|id|gsd_plan|
|taskType|dev|
|inheritCostCap|true|
|type|notify_telegram|
|type|github_issue|
|on|success|
|on|failure|
|on|always|
|category|gsd|

Status Code **401**

|Name|Type|Required|Restrictions|Description|
|---|---|---|---|---|
|» error|string|true|none|none|

<aside class="warning">
To perform this operation, you must be authenticated by means of one of the following methods:
bearerAuth
</aside>

# Schemas

