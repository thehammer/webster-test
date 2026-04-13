# Suite: Maisie Dashboard

## Config
Base URL: https://maisie.example.com

## Scenario: Dashboard loads
Navigate to the base URL.
Verify the page title contains "Maisie".
Verify the Services section is visible showing service statuses.
Verify the Network section is visible showing a device count.

## Scenario: Navigation works
Navigate to the base URL.
Click "Cameras" in the navigation.
Verify camera-related content is shown.
Navigate back to the dashboard using whatever back/home control is available.
Verify the main dashboard content is visible again.

## Scenario: No console errors
Navigate to the base URL.
Click "Media" in the navigation.
Check the browser console for JavaScript errors.
Verify no errors occurred.
