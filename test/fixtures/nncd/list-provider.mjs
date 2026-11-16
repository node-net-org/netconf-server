// A provider module that says where to register itself: { path, provider } entries.
export default (options) => [
  { path: '/writes-test:routing', provider: { startup: 'adopt', load: () => ({ 'writes-test:routing': { route: [{ prefix: options.prefix ?? '10.0.0.0/8', 'next-hop': '192.0.2.1' }] } }) } },
];
