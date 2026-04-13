# Suite: Maisie Dashboard Media Navigation

## Config
- Base URL: https://maisie.example.com

## Scenario: Navigate from Dashboard to Media and back

Navigate to `/#dashboard`.

Verify the page title contains "Maisie — Home Dashboard".

Verify the dashboard shows service tiles including "Services", "Agent", "MQTT", "UniFi", "Synology", and "Plex".

Verify the "Recently Added" section is visible.

Click the "Media" link in the navigation.

Verify the URL hash changes to `#media`.

Verify the page title still contains "Maisie — Home Dashboard".

Click the "TV Shows" button.

Verify the TV Shows view is active on the Media page.

Click the "← Dashboard" button.

Verify the URL hash returns to `#dashboard`.

Verify the dashboard service tiles (such as "Services", "UniFi", "Plex") are visible again.

## Scenario: No console errors during Media navigation

Navigate to `/#dashboard`.

Click the "Media" link in the navigation.

Click the "TV Shows" button.

Click the "← Dashboard" button.

Verify there are no JavaScript errors in the browser console throughout this navigation path.