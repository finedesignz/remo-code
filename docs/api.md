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

<h1 id="remo-code-hub-repo-groups">repo-groups</h1>

## List the user's repo groups with members

> Code samples

```shell
# You can also use wget
curl -X GET https://app.remo-code.com/api/repo-groups \
  -H 'Accept: application/json' \
  -H 'Authorization: Bearer {access-token}'

```

```javascript

const headers = {
  'Accept':'application/json',
  'Authorization':'Bearer {access-token}'
};

fetch('https://app.remo-code.com/api/repo-groups',
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

`GET /api/repo-groups`

> Example responses

> 200 Response

```json
{
  "groups": [
    {
      "id": "497f6eca-6276-4993-bfeb-53cbbbba6f08",
      "name": "string",
      "sort_order": 0,
      "created_at": "string",
      "updated_at": "string",
      "members": [
        {
          "repo_ident": "github://acme/app",
          "created_at": "string"
        }
      ]
    }
  ]
}
```

<h3 id="list-the-user's-repo-groups-with-members-responses">Responses</h3>

|Status|Meaning|Description|Schema|
|---|---|---|---|
|200|[OK](https://tools.ietf.org/html/rfc7231#section-6.3.1)|Groups|Inline|
|401|[Unauthorized](https://tools.ietf.org/html/rfc7235#section-3.1)|Missing or invalid JWT|Inline|

<h3 id="list-the-user's-repo-groups-with-members-responseschema">Response Schema</h3>

Status Code **200**

|Name|Type|Required|Restrictions|Description|
|---|---|---|---|---|
|» groups|[object]|true|none|none|
|»» id|string(uuid)|true|none|none|
|»» name|string|true|none|none|
|»» sort_order|integer|true|none|none|
|»» created_at|string|true|none|none|
|»» updated_at|string|true|none|none|
|»» members|[object]|true|none|none|
|»»» repo_ident|string|true|none|github://owner/repo or path://<abs>|
|»»» created_at|string|true|none|none|

Status Code **401**

|Name|Type|Required|Restrictions|Description|
|---|---|---|---|---|
|» error|string|true|none|none|

<aside class="warning">
To perform this operation, you must be authenticated by means of one of the following methods:
bearerAuth
</aside>

## Create a repo group

> Code samples

```shell
# You can also use wget
curl -X POST https://app.remo-code.com/api/repo-groups \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json' \
  -H 'Authorization: Bearer {access-token}'

```

```javascript
const inputBody = '{
  "name": "string"
}';
const headers = {
  'Content-Type':'application/json',
  'Accept':'application/json',
  'Authorization':'Bearer {access-token}'
};

fetch('https://app.remo-code.com/api/repo-groups',
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

`POST /api/repo-groups`

> Body parameter

```json
{
  "name": "string"
}
```

<h3 id="create-a-repo-group-parameters">Parameters</h3>

|Name|In|Type|Required|Description|
|---|---|---|---|---|
|body|body|object|false|none|
|» name|body|string|true|none|

> Example responses

> 201 Response

```json
{
  "id": "497f6eca-6276-4993-bfeb-53cbbbba6f08",
  "name": "string",
  "sort_order": 0,
  "created_at": "string",
  "updated_at": "string"
}
```

<h3 id="create-a-repo-group-responses">Responses</h3>

|Status|Meaning|Description|Schema|
|---|---|---|---|
|201|[Created](https://tools.ietf.org/html/rfc7231#section-6.3.2)|Created|Inline|
|400|[Bad Request](https://tools.ietf.org/html/rfc7231#section-6.5.1)|Invalid body|Inline|
|401|[Unauthorized](https://tools.ietf.org/html/rfc7235#section-3.1)|Missing or invalid JWT|Inline|
|409|[Conflict](https://tools.ietf.org/html/rfc7231#section-6.5.8)|Group name already exists|Inline|

<h3 id="create-a-repo-group-responseschema">Response Schema</h3>

Status Code **201**

|Name|Type|Required|Restrictions|Description|
|---|---|---|---|---|
|» id|string(uuid)|true|none|none|
|» name|string|true|none|none|
|» sort_order|integer|true|none|none|
|» created_at|string|true|none|none|
|» updated_at|string|true|none|none|

Status Code **400**

|Name|Type|Required|Restrictions|Description|
|---|---|---|---|---|
|» error|string|true|none|none|

Status Code **401**

|Name|Type|Required|Restrictions|Description|
|---|---|---|---|---|
|» error|string|true|none|none|

Status Code **409**

|Name|Type|Required|Restrictions|Description|
|---|---|---|---|---|
|» error|string|true|none|none|

<aside class="warning">
To perform this operation, you must be authenticated by means of one of the following methods:
bearerAuth
</aside>

## Bulk-reorder groups by id

> Code samples

```shell
# You can also use wget
curl -X PUT https://app.remo-code.com/api/repo-groups/reorder \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json' \
  -H 'Authorization: Bearer {access-token}'

```

```javascript
const inputBody = '{
  "ordered_ids": [
    "497f6eca-6276-4993-bfeb-53cbbbba6f08"
  ]
}';
const headers = {
  'Content-Type':'application/json',
  'Accept':'application/json',
  'Authorization':'Bearer {access-token}'
};

fetch('https://app.remo-code.com/api/repo-groups/reorder',
{
  method: 'PUT',
  body: inputBody,
  headers: headers
})
.then(function(res) {
    return res.json();
}).then(function(body) {
    console.log(body);
});

```

`PUT /api/repo-groups/reorder`

> Body parameter

```json
{
  "ordered_ids": [
    "497f6eca-6276-4993-bfeb-53cbbbba6f08"
  ]
}
```

<h3 id="bulk-reorder-groups-by-id-parameters">Parameters</h3>

|Name|In|Type|Required|Description|
|---|---|---|---|---|
|body|body|object|false|none|
|» ordered_ids|body|[string]|true|none|

> Example responses

> 400 Response

```json
{
  "error": "string"
}
```

<h3 id="bulk-reorder-groups-by-id-responses">Responses</h3>

|Status|Meaning|Description|Schema|
|---|---|---|---|
|204|[No Content](https://tools.ietf.org/html/rfc7231#section-6.3.5)|Reordered|None|
|400|[Bad Request](https://tools.ietf.org/html/rfc7231#section-6.5.1)|Invalid body|Inline|
|401|[Unauthorized](https://tools.ietf.org/html/rfc7235#section-3.1)|Missing or invalid JWT|Inline|

<h3 id="bulk-reorder-groups-by-id-responseschema">Response Schema</h3>

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

## Rename and/or reorder a group

> Code samples

```shell
# You can also use wget
curl -X PATCH https://app.remo-code.com/api/repo-groups/{id} \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json' \
  -H 'Authorization: Bearer {access-token}'

```

```javascript
const inputBody = '{
  "name": "string",
  "sort_order": 0
}';
const headers = {
  'Content-Type':'application/json',
  'Accept':'application/json',
  'Authorization':'Bearer {access-token}'
};

fetch('https://app.remo-code.com/api/repo-groups/{id}',
{
  method: 'PATCH',
  body: inputBody,
  headers: headers
})
.then(function(res) {
    return res.json();
}).then(function(body) {
    console.log(body);
});

```

`PATCH /api/repo-groups/{id}`

> Body parameter

```json
{
  "name": "string",
  "sort_order": 0
}
```

<h3 id="rename-and/or-reorder-a-group-parameters">Parameters</h3>

|Name|In|Type|Required|Description|
|---|---|---|---|---|
|id|path|string(uuid)|true|none|
|body|body|object|false|none|
|» name|body|string|false|none|
|» sort_order|body|integer|false|none|

> Example responses

> 200 Response

```json
{
  "id": "497f6eca-6276-4993-bfeb-53cbbbba6f08",
  "name": "string",
  "sort_order": 0,
  "created_at": "string",
  "updated_at": "string"
}
```

<h3 id="rename-and/or-reorder-a-group-responses">Responses</h3>

|Status|Meaning|Description|Schema|
|---|---|---|---|
|200|[OK](https://tools.ietf.org/html/rfc7231#section-6.3.1)|Updated|Inline|
|400|[Bad Request](https://tools.ietf.org/html/rfc7231#section-6.5.1)|Invalid body|Inline|
|401|[Unauthorized](https://tools.ietf.org/html/rfc7235#section-3.1)|Missing or invalid JWT|Inline|
|404|[Not Found](https://tools.ietf.org/html/rfc7231#section-6.5.4)|Not found|Inline|
|409|[Conflict](https://tools.ietf.org/html/rfc7231#section-6.5.8)|Group name already exists|Inline|

<h3 id="rename-and/or-reorder-a-group-responseschema">Response Schema</h3>

Status Code **200**

|Name|Type|Required|Restrictions|Description|
|---|---|---|---|---|
|» id|string(uuid)|true|none|none|
|» name|string|true|none|none|
|» sort_order|integer|true|none|none|
|» created_at|string|true|none|none|
|» updated_at|string|true|none|none|

Status Code **400**

|Name|Type|Required|Restrictions|Description|
|---|---|---|---|---|
|» error|string|true|none|none|

Status Code **401**

|Name|Type|Required|Restrictions|Description|
|---|---|---|---|---|
|» error|string|true|none|none|

Status Code **404**

|Name|Type|Required|Restrictions|Description|
|---|---|---|---|---|
|» error|string|true|none|none|

Status Code **409**

|Name|Type|Required|Restrictions|Description|
|---|---|---|---|---|
|» error|string|true|none|none|

<aside class="warning">
To perform this operation, you must be authenticated by means of one of the following methods:
bearerAuth
</aside>

## Delete a group (members cascade)

> Code samples

```shell
# You can also use wget
curl -X DELETE https://app.remo-code.com/api/repo-groups/{id} \
  -H 'Accept: application/json' \
  -H 'Authorization: Bearer {access-token}'

```

```javascript

const headers = {
  'Accept':'application/json',
  'Authorization':'Bearer {access-token}'
};

fetch('https://app.remo-code.com/api/repo-groups/{id}',
{
  method: 'DELETE',

  headers: headers
})
.then(function(res) {
    return res.json();
}).then(function(body) {
    console.log(body);
});

```

`DELETE /api/repo-groups/{id}`

<h3 id="delete-a-group-(members-cascade)-parameters">Parameters</h3>

|Name|In|Type|Required|Description|
|---|---|---|---|---|
|id|path|string(uuid)|true|none|

> Example responses

> 401 Response

```json
{
  "error": "string"
}
```

<h3 id="delete-a-group-(members-cascade)-responses">Responses</h3>

|Status|Meaning|Description|Schema|
|---|---|---|---|
|204|[No Content](https://tools.ietf.org/html/rfc7231#section-6.3.5)|Deleted|None|
|401|[Unauthorized](https://tools.ietf.org/html/rfc7235#section-3.1)|Missing or invalid JWT|Inline|
|404|[Not Found](https://tools.ietf.org/html/rfc7231#section-6.5.4)|Not found|Inline|

<h3 id="delete-a-group-(members-cascade)-responseschema">Response Schema</h3>

Status Code **401**

|Name|Type|Required|Restrictions|Description|
|---|---|---|---|---|
|» error|string|true|none|none|

Status Code **404**

|Name|Type|Required|Restrictions|Description|
|---|---|---|---|---|
|» error|string|true|none|none|

<aside class="warning">
To perform this operation, you must be authenticated by means of one of the following methods:
bearerAuth
</aside>

## Add a repo to a group (idempotent)

> Code samples

```shell
# You can also use wget
curl -X POST https://app.remo-code.com/api/repo-groups/{id}/members \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json' \
  -H 'Authorization: Bearer {access-token}'

```

```javascript
const inputBody = '{
  "repo_ident": "github://acme/app"
}';
const headers = {
  'Content-Type':'application/json',
  'Accept':'application/json',
  'Authorization':'Bearer {access-token}'
};

fetch('https://app.remo-code.com/api/repo-groups/{id}/members',
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

`POST /api/repo-groups/{id}/members`

> Body parameter

```json
{
  "repo_ident": "github://acme/app"
}
```

<h3 id="add-a-repo-to-a-group-(idempotent)-parameters">Parameters</h3>

|Name|In|Type|Required|Description|
|---|---|---|---|---|
|id|path|string(uuid)|true|none|
|body|body|object|false|none|
|» repo_ident|body|string|true|github://owner/repo or path://<abs>|

> Example responses

> 400 Response

```json
{
  "error": "string"
}
```

<h3 id="add-a-repo-to-a-group-(idempotent)-responses">Responses</h3>

|Status|Meaning|Description|Schema|
|---|---|---|---|
|204|[No Content](https://tools.ietf.org/html/rfc7231#section-6.3.5)|Added|None|
|400|[Bad Request](https://tools.ietf.org/html/rfc7231#section-6.5.1)|Invalid body|Inline|
|401|[Unauthorized](https://tools.ietf.org/html/rfc7235#section-3.1)|Missing or invalid JWT|Inline|
|404|[Not Found](https://tools.ietf.org/html/rfc7231#section-6.5.4)|Not found|Inline|

<h3 id="add-a-repo-to-a-group-(idempotent)-responseschema">Response Schema</h3>

Status Code **400**

|Name|Type|Required|Restrictions|Description|
|---|---|---|---|---|
|» error|string|true|none|none|

Status Code **401**

|Name|Type|Required|Restrictions|Description|
|---|---|---|---|---|
|» error|string|true|none|none|

Status Code **404**

|Name|Type|Required|Restrictions|Description|
|---|---|---|---|---|
|» error|string|true|none|none|

<aside class="warning">
To perform this operation, you must be authenticated by means of one of the following methods:
bearerAuth
</aside>

## Replace a group's full member set

> Code samples

```shell
# You can also use wget
curl -X PUT https://app.remo-code.com/api/repo-groups/{id}/members \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json' \
  -H 'Authorization: Bearer {access-token}'

```

```javascript
const inputBody = '{
  "repo_idents": [
    "github://acme/app"
  ]
}';
const headers = {
  'Content-Type':'application/json',
  'Accept':'application/json',
  'Authorization':'Bearer {access-token}'
};

fetch('https://app.remo-code.com/api/repo-groups/{id}/members',
{
  method: 'PUT',
  body: inputBody,
  headers: headers
})
.then(function(res) {
    return res.json();
}).then(function(body) {
    console.log(body);
});

```

`PUT /api/repo-groups/{id}/members`

> Body parameter

```json
{
  "repo_idents": [
    "github://acme/app"
  ]
}
```

<h3 id="replace-a-group's-full-member-set-parameters">Parameters</h3>

|Name|In|Type|Required|Description|
|---|---|---|---|---|
|id|path|string(uuid)|true|none|
|body|body|object|false|none|
|» repo_idents|body|[string]|true|none|

> Example responses

> 400 Response

```json
{
  "error": "string"
}
```

<h3 id="replace-a-group's-full-member-set-responses">Responses</h3>

|Status|Meaning|Description|Schema|
|---|---|---|---|
|204|[No Content](https://tools.ietf.org/html/rfc7231#section-6.3.5)|Replaced|None|
|400|[Bad Request](https://tools.ietf.org/html/rfc7231#section-6.5.1)|Invalid body|Inline|
|401|[Unauthorized](https://tools.ietf.org/html/rfc7235#section-3.1)|Missing or invalid JWT|Inline|
|404|[Not Found](https://tools.ietf.org/html/rfc7231#section-6.5.4)|Not found|Inline|

<h3 id="replace-a-group's-full-member-set-responseschema">Response Schema</h3>

Status Code **400**

|Name|Type|Required|Restrictions|Description|
|---|---|---|---|---|
|» error|string|true|none|none|

Status Code **401**

|Name|Type|Required|Restrictions|Description|
|---|---|---|---|---|
|» error|string|true|none|none|

Status Code **404**

|Name|Type|Required|Restrictions|Description|
|---|---|---|---|---|
|» error|string|true|none|none|

<aside class="warning">
To perform this operation, you must be authenticated by means of one of the following methods:
bearerAuth
</aside>

## Remove a repo from a group (repo_ident URL-encoded)

> Code samples

```shell
# You can also use wget
curl -X DELETE https://app.remo-code.com/api/repo-groups/{id}/members/{repo_ident} \
  -H 'Accept: application/json' \
  -H 'Authorization: Bearer {access-token}'

```

```javascript

const headers = {
  'Accept':'application/json',
  'Authorization':'Bearer {access-token}'
};

fetch('https://app.remo-code.com/api/repo-groups/{id}/members/{repo_ident}',
{
  method: 'DELETE',

  headers: headers
})
.then(function(res) {
    return res.json();
}).then(function(body) {
    console.log(body);
});

```

`DELETE /api/repo-groups/{id}/members/{repo_ident}`

<h3 id="remove-a-repo-from-a-group-(repo_ident-url-encoded)-parameters">Parameters</h3>

|Name|In|Type|Required|Description|
|---|---|---|---|---|
|id|path|string(uuid)|true|none|
|repo_ident|path|string|true|none|

> Example responses

> 401 Response

```json
{
  "error": "string"
}
```

<h3 id="remove-a-repo-from-a-group-(repo_ident-url-encoded)-responses">Responses</h3>

|Status|Meaning|Description|Schema|
|---|---|---|---|
|204|[No Content](https://tools.ietf.org/html/rfc7231#section-6.3.5)|Removed|None|
|401|[Unauthorized](https://tools.ietf.org/html/rfc7235#section-3.1)|Missing or invalid JWT|Inline|
|404|[Not Found](https://tools.ietf.org/html/rfc7231#section-6.5.4)|Not found|Inline|

<h3 id="remove-a-repo-from-a-group-(repo_ident-url-encoded)-responseschema">Response Schema</h3>

Status Code **401**

|Name|Type|Required|Restrictions|Description|
|---|---|---|---|---|
|» error|string|true|none|none|

Status Code **404**

|Name|Type|Required|Restrictions|Description|
|---|---|---|---|---|
|» error|string|true|none|none|

<aside class="warning">
To perform this operation, you must be authenticated by means of one of the following methods:
bearerAuth
</aside>

## Get per-user collapsed group-section ids

> Code samples

```shell
# You can also use wget
curl -X GET https://app.remo-code.com/api/repo-groups/collapse-state \
  -H 'Accept: application/json' \
  -H 'Authorization: Bearer {access-token}'

```

```javascript

const headers = {
  'Accept':'application/json',
  'Authorization':'Bearer {access-token}'
};

fetch('https://app.remo-code.com/api/repo-groups/collapse-state',
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

`GET /api/repo-groups/collapse-state`

> Example responses

> 200 Response

```json
{
  "collapsed_group_ids": [
    "string"
  ]
}
```

<h3 id="get-per-user-collapsed-group-section-ids-responses">Responses</h3>

|Status|Meaning|Description|Schema|
|---|---|---|---|
|200|[OK](https://tools.ietf.org/html/rfc7231#section-6.3.1)|Collapse state|Inline|
|401|[Unauthorized](https://tools.ietf.org/html/rfc7235#section-3.1)|Missing or invalid JWT|Inline|

<h3 id="get-per-user-collapsed-group-section-ids-responseschema">Response Schema</h3>

Status Code **200**

|Name|Type|Required|Restrictions|Description|
|---|---|---|---|---|
|» collapsed_group_ids|[string]|true|none|none|

Status Code **401**

|Name|Type|Required|Restrictions|Description|
|---|---|---|---|---|
|» error|string|true|none|none|

<aside class="warning">
To perform this operation, you must be authenticated by means of one of the following methods:
bearerAuth
</aside>

## Replace per-user collapsed group-section ids

> Code samples

```shell
# You can also use wget
curl -X PATCH https://app.remo-code.com/api/repo-groups/collapse-state \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json' \
  -H 'Authorization: Bearer {access-token}'

```

```javascript
const inputBody = '{
  "collapsed_group_ids": [
    "string"
  ]
}';
const headers = {
  'Content-Type':'application/json',
  'Accept':'application/json',
  'Authorization':'Bearer {access-token}'
};

fetch('https://app.remo-code.com/api/repo-groups/collapse-state',
{
  method: 'PATCH',
  body: inputBody,
  headers: headers
})
.then(function(res) {
    return res.json();
}).then(function(body) {
    console.log(body);
});

```

`PATCH /api/repo-groups/collapse-state`

> Body parameter

```json
{
  "collapsed_group_ids": [
    "string"
  ]
}
```

<h3 id="replace-per-user-collapsed-group-section-ids-parameters">Parameters</h3>

|Name|In|Type|Required|Description|
|---|---|---|---|---|
|body|body|object|false|none|
|» collapsed_group_ids|body|[string]|true|none|

> Example responses

> 200 Response

```json
{
  "collapsed_group_ids": [
    "string"
  ]
}
```

<h3 id="replace-per-user-collapsed-group-section-ids-responses">Responses</h3>

|Status|Meaning|Description|Schema|
|---|---|---|---|
|200|[OK](https://tools.ietf.org/html/rfc7231#section-6.3.1)|Collapse state|Inline|
|400|[Bad Request](https://tools.ietf.org/html/rfc7231#section-6.5.1)|Invalid body|Inline|
|401|[Unauthorized](https://tools.ietf.org/html/rfc7235#section-3.1)|Missing or invalid JWT|Inline|

<h3 id="replace-per-user-collapsed-group-section-ids-responseschema">Response Schema</h3>

Status Code **200**

|Name|Type|Required|Restrictions|Description|
|---|---|---|---|---|
|» collapsed_group_ids|[string]|true|none|none|

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

<h1 id="remo-code-hub-orchestrator-tasks">orchestrator-tasks</h1>

## Get a session's orchestrator task + its rows (task null if none)

> Code samples

```shell
# You can also use wget
curl -X GET https://app.remo-code.com/api/orchestrator-tasks/{sessionId} \
  -H 'Accept: application/json' \
  -H 'Authorization: Bearer {access-token}'

```

```javascript

const headers = {
  'Accept':'application/json',
  'Authorization':'Bearer {access-token}'
};

fetch('https://app.remo-code.com/api/orchestrator-tasks/{sessionId}',
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

`GET /api/orchestrator-tasks/{sessionId}`

<h3 id="get-a-session's-orchestrator-task-+-its-rows-(task-null-if-none)-parameters">Parameters</h3>

|Name|In|Type|Required|Description|
|---|---|---|---|---|
|sessionId|path|string|true|none|

> Example responses

> 200 Response

```json
{
  "task": {
    "id": "string",
    "user_id": "string",
    "session_id": "string",
    "name": "string",
    "lifecycle_stage": "development",
    "macro_task_type": "dev",
    "enabled": true,
    "created_at": "string",
    "updated_at": "string"
  },
  "rows": [
    {
      "id": "string",
      "task_id": "string",
      "command": "string",
      "enabled": true,
      "schedule_rule": {
        "interval": 0,
        "unit": "minutes",
        "start_at": "string"
      },
      "frequency_label": "string",
      "micro_prompt": "string",
      "sort_order": 0,
      "created_at": "string",
      "updated_at": "string"
    }
  ]
}
```

<h3 id="get-a-session's-orchestrator-task-+-its-rows-(task-null-if-none)-responses">Responses</h3>

|Status|Meaning|Description|Schema|
|---|---|---|---|
|200|[OK](https://tools.ietf.org/html/rfc7231#section-6.3.1)|Task + rows|Inline|
|401|[Unauthorized](https://tools.ietf.org/html/rfc7235#section-3.1)|Missing or invalid JWT|Inline|
|404|[Not Found](https://tools.ietf.org/html/rfc7231#section-6.5.4)|Session not found|Inline|

<h3 id="get-a-session's-orchestrator-task-+-its-rows-(task-null-if-none)-responseschema">Response Schema</h3>

Status Code **200**

|Name|Type|Required|Restrictions|Description|
|---|---|---|---|---|
|» task|object¦null|true|none|none|
|»» id|string|true|none|none|
|»» user_id|string|true|none|none|
|»» session_id|string¦null|true|none|none|
|»» name|string|true|none|none|
|»» lifecycle_stage|string|true|none|none|
|»» macro_task_type|string|true|none|none|
|»» enabled|boolean|true|none|none|
|»» created_at|string|true|none|none|
|»» updated_at|string|true|none|none|
|» rows|[object]|true|none|none|
|»» id|string|true|none|none|
|»» task_id|string|true|none|none|
|»» command|string|true|none|none|
|»» enabled|boolean|true|none|none|
|»» schedule_rule|object¦null|true|none|none|
|»»» interval|integer|true|none|none|
|»»» unit|string|true|none|none|
|»»» start_at|string|true|none|none|
|»» frequency_label|string¦null|true|none|none|
|»» micro_prompt|string¦null|true|none|none|
|»» sort_order|integer|true|none|none|
|»» created_at|string|true|none|none|
|»» updated_at|string|true|none|none|

#### Enumerated Values

|Property|Value|
|---|---|
|lifecycle_stage|development|
|lifecycle_stage|beta|
|lifecycle_stage|production-maintenance|
|macro_task_type|dev|
|macro_task_type|maintenance|
|macro_task_type|security|
|macro_task_type|brainstorming|
|unit|minutes|
|unit|hours|
|unit|days|
|unit|weeks|
|unit|months|

Status Code **401**

|Name|Type|Required|Restrictions|Description|
|---|---|---|---|---|
|» error|string|true|none|none|

Status Code **404**

|Name|Type|Required|Restrictions|Description|
|---|---|---|---|---|
|» error|string|true|none|none|

<aside class="warning">
To perform this operation, you must be authenticated by means of one of the following methods:
bearerAuth
</aside>

## Create the one orchestrator task for a session

> Code samples

```shell
# You can also use wget
curl -X POST https://app.remo-code.com/api/orchestrator-tasks/{sessionId} \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json' \
  -H 'Authorization: Bearer {access-token}'

```

```javascript
const inputBody = '{
  "lifecycle_stage": "development",
  "name": "string",
  "macro_task_type": "dev"
}';
const headers = {
  'Content-Type':'application/json',
  'Accept':'application/json',
  'Authorization':'Bearer {access-token}'
};

fetch('https://app.remo-code.com/api/orchestrator-tasks/{sessionId}',
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

`POST /api/orchestrator-tasks/{sessionId}`

> Body parameter

```json
{
  "lifecycle_stage": "development",
  "name": "string",
  "macro_task_type": "dev"
}
```

<h3 id="create-the-one-orchestrator-task-for-a-session-parameters">Parameters</h3>

|Name|In|Type|Required|Description|
|---|---|---|---|---|
|sessionId|path|string|true|none|
|body|body|object|false|none|
|» lifecycle_stage|body|string|false|none|
|» name|body|string|false|none|
|» macro_task_type|body|string|false|none|

#### Enumerated Values

|Parameter|Value|
|---|---|
|» lifecycle_stage|development|
|» lifecycle_stage|beta|
|» lifecycle_stage|production-maintenance|
|» macro_task_type|dev|
|» macro_task_type|maintenance|
|» macro_task_type|security|
|» macro_task_type|brainstorming|

> Example responses

> 201 Response

```json
{
  "task": {
    "id": "string",
    "user_id": "string",
    "session_id": "string",
    "name": "string",
    "lifecycle_stage": "development",
    "macro_task_type": "dev",
    "enabled": true,
    "created_at": "string",
    "updated_at": "string"
  },
  "rows": [
    {
      "id": "string",
      "task_id": "string",
      "command": "string",
      "enabled": true,
      "schedule_rule": {
        "interval": 0,
        "unit": "minutes",
        "start_at": "string"
      },
      "frequency_label": "string",
      "micro_prompt": "string",
      "sort_order": 0,
      "created_at": "string",
      "updated_at": "string"
    }
  ]
}
```

<h3 id="create-the-one-orchestrator-task-for-a-session-responses">Responses</h3>

|Status|Meaning|Description|Schema|
|---|---|---|---|
|201|[Created](https://tools.ietf.org/html/rfc7231#section-6.3.2)|Created|Inline|
|401|[Unauthorized](https://tools.ietf.org/html/rfc7235#section-3.1)|Missing or invalid JWT|Inline|
|404|[Not Found](https://tools.ietf.org/html/rfc7231#section-6.5.4)|Session not found|Inline|
|409|[Conflict](https://tools.ietf.org/html/rfc7231#section-6.5.8)|Session already has an orchestrator task|Inline|

<h3 id="create-the-one-orchestrator-task-for-a-session-responseschema">Response Schema</h3>

Status Code **201**

|Name|Type|Required|Restrictions|Description|
|---|---|---|---|---|
|» task|object¦null|true|none|none|
|»» id|string|true|none|none|
|»» user_id|string|true|none|none|
|»» session_id|string¦null|true|none|none|
|»» name|string|true|none|none|
|»» lifecycle_stage|string|true|none|none|
|»» macro_task_type|string|true|none|none|
|»» enabled|boolean|true|none|none|
|»» created_at|string|true|none|none|
|»» updated_at|string|true|none|none|
|» rows|[object]|true|none|none|
|»» id|string|true|none|none|
|»» task_id|string|true|none|none|
|»» command|string|true|none|none|
|»» enabled|boolean|true|none|none|
|»» schedule_rule|object¦null|true|none|none|
|»»» interval|integer|true|none|none|
|»»» unit|string|true|none|none|
|»»» start_at|string|true|none|none|
|»» frequency_label|string¦null|true|none|none|
|»» micro_prompt|string¦null|true|none|none|
|»» sort_order|integer|true|none|none|
|»» created_at|string|true|none|none|
|»» updated_at|string|true|none|none|

#### Enumerated Values

|Property|Value|
|---|---|
|lifecycle_stage|development|
|lifecycle_stage|beta|
|lifecycle_stage|production-maintenance|
|macro_task_type|dev|
|macro_task_type|maintenance|
|macro_task_type|security|
|macro_task_type|brainstorming|
|unit|minutes|
|unit|hours|
|unit|days|
|unit|weeks|
|unit|months|

Status Code **401**

|Name|Type|Required|Restrictions|Description|
|---|---|---|---|---|
|» error|string|true|none|none|

Status Code **404**

|Name|Type|Required|Restrictions|Description|
|---|---|---|---|---|
|» error|string|true|none|none|

Status Code **409**

|Name|Type|Required|Restrictions|Description|
|---|---|---|---|---|
|» error|string|true|none|none|

<aside class="warning">
To perform this operation, you must be authenticated by means of one of the following methods:
bearerAuth
</aside>

## Update the task's lifecycle stage and/or macro task type

> Code samples

```shell
# You can also use wget
curl -X PATCH https://app.remo-code.com/api/orchestrator-tasks/{taskId} \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json' \
  -H 'Authorization: Bearer {access-token}'

```

```javascript
const inputBody = '{
  "lifecycle_stage": "development",
  "macro_task_type": "dev"
}';
const headers = {
  'Content-Type':'application/json',
  'Accept':'application/json',
  'Authorization':'Bearer {access-token}'
};

fetch('https://app.remo-code.com/api/orchestrator-tasks/{taskId}',
{
  method: 'PATCH',
  body: inputBody,
  headers: headers
})
.then(function(res) {
    return res.json();
}).then(function(body) {
    console.log(body);
});

```

`PATCH /api/orchestrator-tasks/{taskId}`

> Body parameter

```json
{
  "lifecycle_stage": "development",
  "macro_task_type": "dev"
}
```

<h3 id="update-the-task's-lifecycle-stage-and/or-macro-task-type-parameters">Parameters</h3>

|Name|In|Type|Required|Description|
|---|---|---|---|---|
|taskId|path|string|true|none|
|body|body|object|false|none|
|» lifecycle_stage|body|string|false|none|
|» macro_task_type|body|string|false|none|

#### Enumerated Values

|Parameter|Value|
|---|---|
|» lifecycle_stage|development|
|» lifecycle_stage|beta|
|» lifecycle_stage|production-maintenance|
|» macro_task_type|dev|
|» macro_task_type|maintenance|
|» macro_task_type|security|
|» macro_task_type|brainstorming|

> Example responses

> 200 Response

```json
{
  "task": {
    "id": "string",
    "user_id": "string",
    "session_id": "string",
    "name": "string",
    "lifecycle_stage": "development",
    "macro_task_type": "dev",
    "enabled": true,
    "created_at": "string",
    "updated_at": "string"
  }
}
```

<h3 id="update-the-task's-lifecycle-stage-and/or-macro-task-type-responses">Responses</h3>

|Status|Meaning|Description|Schema|
|---|---|---|---|
|200|[OK](https://tools.ietf.org/html/rfc7231#section-6.3.1)|Updated|Inline|
|400|[Bad Request](https://tools.ietf.org/html/rfc7231#section-6.5.1)|Invalid body|Inline|
|401|[Unauthorized](https://tools.ietf.org/html/rfc7235#section-3.1)|Missing or invalid JWT|Inline|
|404|[Not Found](https://tools.ietf.org/html/rfc7231#section-6.5.4)|Task not found|Inline|

<h3 id="update-the-task's-lifecycle-stage-and/or-macro-task-type-responseschema">Response Schema</h3>

Status Code **200**

|Name|Type|Required|Restrictions|Description|
|---|---|---|---|---|
|» task|object|true|none|none|
|»» id|string|true|none|none|
|»» user_id|string|true|none|none|
|»» session_id|string¦null|true|none|none|
|»» name|string|true|none|none|
|»» lifecycle_stage|string|true|none|none|
|»» macro_task_type|string|true|none|none|
|»» enabled|boolean|true|none|none|
|»» created_at|string|true|none|none|
|»» updated_at|string|true|none|none|

#### Enumerated Values

|Property|Value|
|---|---|
|lifecycle_stage|development|
|lifecycle_stage|beta|
|lifecycle_stage|production-maintenance|
|macro_task_type|dev|
|macro_task_type|maintenance|
|macro_task_type|security|
|macro_task_type|brainstorming|

Status Code **400**

|Name|Type|Required|Restrictions|Description|
|---|---|---|---|---|
|» error|string|true|none|none|

Status Code **401**

|Name|Type|Required|Restrictions|Description|
|---|---|---|---|---|
|» error|string|true|none|none|

Status Code **404**

|Name|Type|Required|Restrictions|Description|
|---|---|---|---|---|
|» error|string|true|none|none|

<aside class="warning">
To perform this operation, you must be authenticated by means of one of the following methods:
bearerAuth
</aside>

## Apply a lifecycle-stage frequency preset to the rows

> Code samples

```shell
# You can also use wget
curl -X POST https://app.remo-code.com/api/orchestrator-tasks/{taskId}/apply-preset \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json' \
  -H 'Authorization: Bearer {access-token}'

```

```javascript
const inputBody = '{
  "stage": "development",
  "overwrite": true
}';
const headers = {
  'Content-Type':'application/json',
  'Accept':'application/json',
  'Authorization':'Bearer {access-token}'
};

fetch('https://app.remo-code.com/api/orchestrator-tasks/{taskId}/apply-preset',
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

`POST /api/orchestrator-tasks/{taskId}/apply-preset`

> Body parameter

```json
{
  "stage": "development",
  "overwrite": true
}
```

<h3 id="apply-a-lifecycle-stage-frequency-preset-to-the-rows-parameters">Parameters</h3>

|Name|In|Type|Required|Description|
|---|---|---|---|---|
|taskId|path|string|true|none|
|body|body|object|false|none|
|» stage|body|string|false|none|
|» overwrite|body|boolean|false|none|

#### Enumerated Values

|Parameter|Value|
|---|---|
|» stage|development|
|» stage|beta|
|» stage|production-maintenance|

> Example responses

> 200 Response

```json
{
  "result": null,
  "rows": [
    {
      "id": "string",
      "task_id": "string",
      "command": "string",
      "enabled": true,
      "schedule_rule": {
        "interval": 0,
        "unit": "minutes",
        "start_at": "string"
      },
      "frequency_label": "string",
      "micro_prompt": "string",
      "sort_order": 0,
      "created_at": "string",
      "updated_at": "string"
    }
  ]
}
```

<h3 id="apply-a-lifecycle-stage-frequency-preset-to-the-rows-responses">Responses</h3>

|Status|Meaning|Description|Schema|
|---|---|---|---|
|200|[OK](https://tools.ietf.org/html/rfc7231#section-6.3.1)|Preset applied|Inline|
|401|[Unauthorized](https://tools.ietf.org/html/rfc7235#section-3.1)|Missing or invalid JWT|Inline|
|404|[Not Found](https://tools.ietf.org/html/rfc7231#section-6.5.4)|Task not found|Inline|

<h3 id="apply-a-lifecycle-stage-frequency-preset-to-the-rows-responseschema">Response Schema</h3>

Status Code **200**

|Name|Type|Required|Restrictions|Description|
|---|---|---|---|---|
|» result|any|false|none|none|
|» rows|[object]|true|none|none|
|»» id|string|true|none|none|
|»» task_id|string|true|none|none|
|»» command|string|true|none|none|
|»» enabled|boolean|true|none|none|
|»» schedule_rule|object¦null|true|none|none|
|»»» interval|integer|true|none|none|
|»»» unit|string|true|none|none|
|»»» start_at|string|true|none|none|
|»» frequency_label|string¦null|true|none|none|
|»» micro_prompt|string¦null|true|none|none|
|»» sort_order|integer|true|none|none|
|»» created_at|string|true|none|none|
|»» updated_at|string|true|none|none|

#### Enumerated Values

|Property|Value|
|---|---|
|unit|minutes|
|unit|hours|
|unit|days|
|unit|weeks|
|unit|months|

Status Code **401**

|Name|Type|Required|Restrictions|Description|
|---|---|---|---|---|
|» error|string|true|none|none|

Status Code **404**

|Name|Type|Required|Restrictions|Description|
|---|---|---|---|---|
|» error|string|true|none|none|

<aside class="warning">
To perform this operation, you must be authenticated by means of one of the following methods:
bearerAuth
</aside>

## Add a command row or a micro-prompt row

> Code samples

```shell
# You can also use wget
curl -X POST https://app.remo-code.com/api/orchestrator-tasks/{taskId}/rows \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json' \
  -H 'Authorization: Bearer {access-token}'

```

```javascript
const inputBody = '{
  "command": "string",
  "micro_prompt": "string",
  "enabled": true,
  "frequency_label": "string",
  "schedule_rule": {
    "interval": 0,
    "unit": "minutes",
    "start_at": "string"
  },
  "sort_order": 0
}';
const headers = {
  'Content-Type':'application/json',
  'Accept':'application/json',
  'Authorization':'Bearer {access-token}'
};

fetch('https://app.remo-code.com/api/orchestrator-tasks/{taskId}/rows',
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

`POST /api/orchestrator-tasks/{taskId}/rows`

> Body parameter

```json
{
  "command": "string",
  "micro_prompt": "string",
  "enabled": true,
  "frequency_label": "string",
  "schedule_rule": {
    "interval": 0,
    "unit": "minutes",
    "start_at": "string"
  },
  "sort_order": 0
}
```

<h3 id="add-a-command-row-or-a-micro-prompt-row-parameters">Parameters</h3>

|Name|In|Type|Required|Description|
|---|---|---|---|---|
|taskId|path|string|true|none|
|body|body|object|false|none|
|» command|body|string|false|none|
|» micro_prompt|body|string|false|none|
|» enabled|body|boolean|false|none|
|» frequency_label|body|string|false|none|
|» schedule_rule|body|object¦null|false|none|
|»» interval|body|integer|true|none|
|»» unit|body|string|true|none|
|»» start_at|body|string|true|none|
|» sort_order|body|integer|false|none|

#### Enumerated Values

|Parameter|Value|
|---|---|
|»» unit|minutes|
|»» unit|hours|
|»» unit|days|
|»» unit|weeks|
|»» unit|months|

> Example responses

> 201 Response

```json
{
  "row": {
    "id": "string",
    "task_id": "string",
    "command": "string",
    "enabled": true,
    "schedule_rule": {
      "interval": 0,
      "unit": "minutes",
      "start_at": "string"
    },
    "frequency_label": "string",
    "micro_prompt": "string",
    "sort_order": 0,
    "created_at": "string",
    "updated_at": "string"
  }
}
```

<h3 id="add-a-command-row-or-a-micro-prompt-row-responses">Responses</h3>

|Status|Meaning|Description|Schema|
|---|---|---|---|
|201|[Created](https://tools.ietf.org/html/rfc7231#section-6.3.2)|Created|Inline|
|400|[Bad Request](https://tools.ietf.org/html/rfc7231#section-6.5.1)|Invalid body|Inline|
|401|[Unauthorized](https://tools.ietf.org/html/rfc7235#section-3.1)|Missing or invalid JWT|Inline|
|404|[Not Found](https://tools.ietf.org/html/rfc7231#section-6.5.4)|Task not found|Inline|

<h3 id="add-a-command-row-or-a-micro-prompt-row-responseschema">Response Schema</h3>

Status Code **201**

|Name|Type|Required|Restrictions|Description|
|---|---|---|---|---|
|» row|object|true|none|none|
|»» id|string|true|none|none|
|»» task_id|string|true|none|none|
|»» command|string|true|none|none|
|»» enabled|boolean|true|none|none|
|»» schedule_rule|object¦null|true|none|none|
|»»» interval|integer|true|none|none|
|»»» unit|string|true|none|none|
|»»» start_at|string|true|none|none|
|»» frequency_label|string¦null|true|none|none|
|»» micro_prompt|string¦null|true|none|none|
|»» sort_order|integer|true|none|none|
|»» created_at|string|true|none|none|
|»» updated_at|string|true|none|none|

#### Enumerated Values

|Property|Value|
|---|---|
|unit|minutes|
|unit|hours|
|unit|days|
|unit|weeks|
|unit|months|

Status Code **400**

|Name|Type|Required|Restrictions|Description|
|---|---|---|---|---|
|» error|string|true|none|none|

Status Code **401**

|Name|Type|Required|Restrictions|Description|
|---|---|---|---|---|
|» error|string|true|none|none|

Status Code **404**

|Name|Type|Required|Restrictions|Description|
|---|---|---|---|---|
|» error|string|true|none|none|

<aside class="warning">
To perform this operation, you must be authenticated by means of one of the following methods:
bearerAuth
</aside>

## Update a row (enabled / frequency / schedule_rule / micro_prompt / sort_order)

> Code samples

```shell
# You can also use wget
curl -X PATCH https://app.remo-code.com/api/orchestrator-tasks/rows/{rowId} \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json' \
  -H 'Authorization: Bearer {access-token}'

```

```javascript
const inputBody = '{
  "enabled": true,
  "frequency_label": "string",
  "micro_prompt": "string",
  "schedule_rule": {
    "interval": 0,
    "unit": "minutes",
    "start_at": "string"
  },
  "sort_order": 0
}';
const headers = {
  'Content-Type':'application/json',
  'Accept':'application/json',
  'Authorization':'Bearer {access-token}'
};

fetch('https://app.remo-code.com/api/orchestrator-tasks/rows/{rowId}',
{
  method: 'PATCH',
  body: inputBody,
  headers: headers
})
.then(function(res) {
    return res.json();
}).then(function(body) {
    console.log(body);
});

```

`PATCH /api/orchestrator-tasks/rows/{rowId}`

> Body parameter

```json
{
  "enabled": true,
  "frequency_label": "string",
  "micro_prompt": "string",
  "schedule_rule": {
    "interval": 0,
    "unit": "minutes",
    "start_at": "string"
  },
  "sort_order": 0
}
```

<h3 id="update-a-row-(enabled-/-frequency-/-schedule_rule-/-micro_prompt-/-sort_order)-parameters">Parameters</h3>

|Name|In|Type|Required|Description|
|---|---|---|---|---|
|rowId|path|string|true|none|
|body|body|object|false|none|
|» enabled|body|boolean|false|none|
|» frequency_label|body|string¦null|false|none|
|» micro_prompt|body|string¦null|false|none|
|» schedule_rule|body|object¦null|false|none|
|»» interval|body|integer|true|none|
|»» unit|body|string|true|none|
|»» start_at|body|string|true|none|
|» sort_order|body|integer|false|none|

#### Enumerated Values

|Parameter|Value|
|---|---|
|»» unit|minutes|
|»» unit|hours|
|»» unit|days|
|»» unit|weeks|
|»» unit|months|

> Example responses

> 200 Response

```json
{
  "row": {
    "id": "string",
    "task_id": "string",
    "command": "string",
    "enabled": true,
    "schedule_rule": {
      "interval": 0,
      "unit": "minutes",
      "start_at": "string"
    },
    "frequency_label": "string",
    "micro_prompt": "string",
    "sort_order": 0,
    "created_at": "string",
    "updated_at": "string"
  }
}
```

<h3 id="update-a-row-(enabled-/-frequency-/-schedule_rule-/-micro_prompt-/-sort_order)-responses">Responses</h3>

|Status|Meaning|Description|Schema|
|---|---|---|---|
|200|[OK](https://tools.ietf.org/html/rfc7231#section-6.3.1)|Updated|Inline|
|400|[Bad Request](https://tools.ietf.org/html/rfc7231#section-6.5.1)|Invalid body|Inline|
|401|[Unauthorized](https://tools.ietf.org/html/rfc7235#section-3.1)|Missing or invalid JWT|Inline|
|404|[Not Found](https://tools.ietf.org/html/rfc7231#section-6.5.4)|Row not found|Inline|

<h3 id="update-a-row-(enabled-/-frequency-/-schedule_rule-/-micro_prompt-/-sort_order)-responseschema">Response Schema</h3>

Status Code **200**

|Name|Type|Required|Restrictions|Description|
|---|---|---|---|---|
|» row|object|true|none|none|
|»» id|string|true|none|none|
|»» task_id|string|true|none|none|
|»» command|string|true|none|none|
|»» enabled|boolean|true|none|none|
|»» schedule_rule|object¦null|true|none|none|
|»»» interval|integer|true|none|none|
|»»» unit|string|true|none|none|
|»»» start_at|string|true|none|none|
|»» frequency_label|string¦null|true|none|none|
|»» micro_prompt|string¦null|true|none|none|
|»» sort_order|integer|true|none|none|
|»» created_at|string|true|none|none|
|»» updated_at|string|true|none|none|

#### Enumerated Values

|Property|Value|
|---|---|
|unit|minutes|
|unit|hours|
|unit|days|
|unit|weeks|
|unit|months|

Status Code **400**

|Name|Type|Required|Restrictions|Description|
|---|---|---|---|---|
|» error|string|true|none|none|

Status Code **401**

|Name|Type|Required|Restrictions|Description|
|---|---|---|---|---|
|» error|string|true|none|none|

Status Code **404**

|Name|Type|Required|Restrictions|Description|
|---|---|---|---|---|
|» error|string|true|none|none|

<aside class="warning">
To perform this operation, you must be authenticated by means of one of the following methods:
bearerAuth
</aside>

## Delete a row

> Code samples

```shell
# You can also use wget
curl -X DELETE https://app.remo-code.com/api/orchestrator-tasks/rows/{rowId} \
  -H 'Accept: application/json' \
  -H 'Authorization: Bearer {access-token}'

```

```javascript

const headers = {
  'Accept':'application/json',
  'Authorization':'Bearer {access-token}'
};

fetch('https://app.remo-code.com/api/orchestrator-tasks/rows/{rowId}',
{
  method: 'DELETE',

  headers: headers
})
.then(function(res) {
    return res.json();
}).then(function(body) {
    console.log(body);
});

```

`DELETE /api/orchestrator-tasks/rows/{rowId}`

<h3 id="delete-a-row-parameters">Parameters</h3>

|Name|In|Type|Required|Description|
|---|---|---|---|---|
|rowId|path|string|true|none|

> Example responses

> 200 Response

```json
{
  "ok": true
}
```

<h3 id="delete-a-row-responses">Responses</h3>

|Status|Meaning|Description|Schema|
|---|---|---|---|
|200|[OK](https://tools.ietf.org/html/rfc7231#section-6.3.1)|Deleted|Inline|
|401|[Unauthorized](https://tools.ietf.org/html/rfc7235#section-3.1)|Missing or invalid JWT|Inline|
|404|[Not Found](https://tools.ietf.org/html/rfc7231#section-6.5.4)|Row not found|Inline|

<h3 id="delete-a-row-responseschema">Response Schema</h3>

Status Code **200**

|Name|Type|Required|Restrictions|Description|
|---|---|---|---|---|
|» ok|boolean|true|none|none|

Status Code **401**

|Name|Type|Required|Restrictions|Description|
|---|---|---|---|---|
|» error|string|true|none|none|

Status Code **404**

|Name|Type|Required|Restrictions|Description|
|---|---|---|---|---|
|» error|string|true|none|none|

<aside class="warning">
To perform this operation, you must be authenticated by means of one of the following methods:
bearerAuth
</aside>

## Bulk-reorder a task's rows by id

> Code samples

```shell
# You can also use wget
curl -X POST https://app.remo-code.com/api/orchestrator-tasks/{taskId}/rows/reorder \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json' \
  -H 'Authorization: Bearer {access-token}'

```

```javascript
const inputBody = '{
  "ordered_ids": [
    "string"
  ]
}';
const headers = {
  'Content-Type':'application/json',
  'Accept':'application/json',
  'Authorization':'Bearer {access-token}'
};

fetch('https://app.remo-code.com/api/orchestrator-tasks/{taskId}/rows/reorder',
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

`POST /api/orchestrator-tasks/{taskId}/rows/reorder`

> Body parameter

```json
{
  "ordered_ids": [
    "string"
  ]
}
```

<h3 id="bulk-reorder-a-task's-rows-by-id-parameters">Parameters</h3>

|Name|In|Type|Required|Description|
|---|---|---|---|---|
|taskId|path|string|true|none|
|body|body|object|false|none|
|» ordered_ids|body|[string]|true|none|

> Example responses

> 200 Response

```json
{
  "rows": [
    {
      "id": "string",
      "task_id": "string",
      "command": "string",
      "enabled": true,
      "schedule_rule": {
        "interval": 0,
        "unit": "minutes",
        "start_at": "string"
      },
      "frequency_label": "string",
      "micro_prompt": "string",
      "sort_order": 0,
      "created_at": "string",
      "updated_at": "string"
    }
  ]
}
```

<h3 id="bulk-reorder-a-task's-rows-by-id-responses">Responses</h3>

|Status|Meaning|Description|Schema|
|---|---|---|---|
|200|[OK](https://tools.ietf.org/html/rfc7231#section-6.3.1)|Reordered|Inline|
|400|[Bad Request](https://tools.ietf.org/html/rfc7231#section-6.5.1)|Invalid body|Inline|
|401|[Unauthorized](https://tools.ietf.org/html/rfc7235#section-3.1)|Missing or invalid JWT|Inline|
|404|[Not Found](https://tools.ietf.org/html/rfc7231#section-6.5.4)|Task not found|Inline|

<h3 id="bulk-reorder-a-task's-rows-by-id-responseschema">Response Schema</h3>

Status Code **200**

|Name|Type|Required|Restrictions|Description|
|---|---|---|---|---|
|» rows|[object]|true|none|none|
|»» id|string|true|none|none|
|»» task_id|string|true|none|none|
|»» command|string|true|none|none|
|»» enabled|boolean|true|none|none|
|»» schedule_rule|object¦null|true|none|none|
|»»» interval|integer|true|none|none|
|»»» unit|string|true|none|none|
|»»» start_at|string|true|none|none|
|»» frequency_label|string¦null|true|none|none|
|»» micro_prompt|string¦null|true|none|none|
|»» sort_order|integer|true|none|none|
|»» created_at|string|true|none|none|
|»» updated_at|string|true|none|none|

#### Enumerated Values

|Property|Value|
|---|---|
|unit|minutes|
|unit|hours|
|unit|days|
|unit|weeks|
|unit|months|

Status Code **400**

|Name|Type|Required|Restrictions|Description|
|---|---|---|---|---|
|» error|string|true|none|none|

Status Code **401**

|Name|Type|Required|Restrictions|Description|
|---|---|---|---|---|
|» error|string|true|none|none|

Status Code **404**

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

<h1 id="remo-code-hub-feedback">feedback</h1>

## Submit end-user feedback (screenshot + description) into the bound session

> Code samples

```shell
# You can also use wget
curl -X POST https://app.remo-code.com/api/feedback/{token} \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json'

```

```javascript
const inputBody = '{
  "comment": "string",
  "screenshot": "string",
  "page_url": "string",
  "console_errors": "string"
}';
const headers = {
  'Content-Type':'application/json',
  'Accept':'application/json'
};

fetch('https://app.remo-code.com/api/feedback/{token}',
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

`POST /api/feedback/{token}`

Public, unauthenticated-by-design. The opaque `fb_` token in the URL IS the credential (SHA-256-hashed lookup against feedback_keys). Accepts a bug description, optional screenshot (base64 data-URI), page URL, and captured console errors, and dispatches them into the app's bound remo-code session via the shared cost-capped dispatch pipeline. Bounded by per-token + per-IP rate limits and the non-bypassable daily cost cap.

> Body parameter

```json
{
  "comment": "string",
  "screenshot": "string",
  "page_url": "string",
  "console_errors": "string"
}
```

<h3 id="submit-end-user-feedback-(screenshot-+-description)-into-the-bound-session-parameters">Parameters</h3>

|Name|In|Type|Required|Description|
|---|---|---|---|---|
|token|path|string|true|none|
|body|body|object|false|none|
|» comment|body|string|true|Required bug/feedback description.|
|» screenshot|body|string|false|Optional base64 data-URI image (image/png|jpeg|gif|webp), ≤~10MB.|
|» page_url|body|string|false|none|
|» console_errors|body|string|false|none|

> Example responses

> 202 Response

```json
{
  "ok": true,
  "status": "string"
}
```

<h3 id="submit-end-user-feedback-(screenshot-+-description)-into-the-bound-session-responses">Responses</h3>

|Status|Meaning|Description|Schema|
|---|---|---|---|
|202|[Accepted](https://tools.ietf.org/html/rfc7231#section-6.3.3)|Accepted + dispatched (fire-and-forget)|Inline|
|400|[Bad Request](https://tools.ietf.org/html/rfc7231#section-6.5.1)|Missing/invalid comment or screenshot|Inline|
|403|[Forbidden](https://tools.ietf.org/html/rfc7231#section-6.5.3)|Feedback key disabled|Inline|
|404|[Not Found](https://tools.ietf.org/html/rfc7231#section-6.5.4)|Unknown token|Inline|
|413|[Payload Too Large](https://tools.ietf.org/html/rfc7231#section-6.5.11)|Payload too large (comment/screenshot/console_errors cap)|Inline|
|429|[Too Many Requests](https://tools.ietf.org/html/rfc6585#section-4)|Rate limited (per-token or per-IP)|Inline|

<h3 id="submit-end-user-feedback-(screenshot-+-description)-into-the-bound-session-responseschema">Response Schema</h3>

Status Code **202**

|Name|Type|Required|Restrictions|Description|
|---|---|---|---|---|
|» ok|boolean|true|none|none|
|» status|string|true|none|none|

Status Code **400**

|Name|Type|Required|Restrictions|Description|
|---|---|---|---|---|
|» error|string|true|none|none|

Status Code **403**

|Name|Type|Required|Restrictions|Description|
|---|---|---|---|---|
|» error|string|true|none|none|

Status Code **404**

|Name|Type|Required|Restrictions|Description|
|---|---|---|---|---|
|» error|string|true|none|none|

Status Code **413**

|Name|Type|Required|Restrictions|Description|
|---|---|---|---|---|
|» error|string|true|none|none|

Status Code **429**

|Name|Type|Required|Restrictions|Description|
|---|---|---|---|---|
|» error|string|true|none|none|

<aside class="success">
This operation does not require authentication
</aside>

# Schemas

