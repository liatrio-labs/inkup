// The React fixture's app (react.html): plain createElement, no JSX and no bundler, so React's development build
// records this file's URL and line in each element's owner stack.
const h = window.React.createElement;

function CtaButton({ label }) {
  return h('button', { id: 'cta', className: 'cta', type: 'button' }, label);
}

function PricingCard() {
  return h(
    'div',
    { className: 'card hero-card' },
    h('p', null, 'Start your free trial today.'),
    h(CtaButton, { label: 'Get started' }),
  );
}

function App() {
  return h(
    'section',
    { className: 'hero', 'aria-labelledby': 'hero-title' },
    h(
      'div',
      null,
      h('h1', { id: 'hero-title' }, 'Ship reviews in minutes'),
      h('p', { className: 'lede' }, 'Simple pricing for teams of every size.'),
    ),
    h(PricingCard),
  );
}

window.ReactDOM.createRoot(document.getElementById('root')).render(h(App));
