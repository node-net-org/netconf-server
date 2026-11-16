// A provider module whose factory fails.
export default () => {
  throw new Error('backend unreachable');
};
