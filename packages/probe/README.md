# @rootnative/loupe-probe

The in-app helper of [loupe](https://github.com/rootnative/loupe#readme).

Some facts about a screen are known only inside your app: the safe-area
insets of the current orientation, the window size, and the layout direction.
The probe reports them to loupe, in development only.

> The probe is in alpha, as loupe is. A new version can change its report.

## Install

```sh
npm install --save-dev @rootnative/loupe-probe
```

The probe needs `react`, `react-native` and `react-native-safe-area-context`
in your app.

## Use

Render `<LoupeProbe />` once, near the root of your app, inside your
`SafeAreaProvider`:

```tsx
import { LoupeProbe } from '@rootnative/loupe-probe'
import { SafeAreaProvider } from 'react-native-safe-area-context'

export default function App() {
  return (
    <SafeAreaProvider>
      <Navigation />
      <LoupeProbe />
    </SafeAreaProvider>
  )
}
```

Pass the current route, so that loupe can show it in a report:

```tsx
<LoupeProbe route={pathname} />
```

Keep the probe on the screen: not in a scroll view, and not in a screen that
is hidden. loupe reads it only while it is on the screen.

## What it reports

The probe renders one view of 1 × 1 point at the top-left corner of its
parent. The view draws nothing and takes no touch. Its accessibility label
holds `loupe:` and a short JSON report:

| Field | What it is |
| --- | --- |
| `insets` | The safe-area insets of the current orientation, from the nearest `SafeAreaProvider`. Left out when there is no provider. |
| `window` | The window size. |
| `scale` | Pixels per point (pt on iOS, dp on Android). |
| `direction` | `ltr` or `rtl`. |
| `colorScheme` | `light` or `dark`. Left out when the system gives none. |
| `route` | The `route` prop, when you pass one. |

loupe finds the label in the accessibility tree that it reads already, so
the probe needs no network and no port. The label holds these fields and
nothing else from your app. Don't put private data in the route.

Screen readers skip the view: TalkBack and VoiceOver don't read it.

## Release builds

`LoupeProbe` renders nothing unless `__DEV__` is true, so a release build
shows no probe.

## License

MIT
