// Protocol tests replace only the visual library boundary. Preserve the public
// value/selection callbacks so the same tests still exercise the real forms.
export const fieldStubs = `
export const PageActions = ({ title, children, onBack, backLabel = '返回列表' }) => createElement('header', null, onBack && createElement('button', { type: 'button', 'aria-label': backLabel, onClick: onBack }, '返回列表'), createElement('h2', null, title), children);
export const ResourceIcon = () => null;
export const ResourceEmpty = ({ title, children }) => createElement('div', null, createElement('h3', null, title), children);
export const SettingDisclosure = ({ heading, children, defaultExpanded }) => createElement('details', { open: defaultExpanded }, createElement('summary', null, heading), children);
export const Field = ({ label, value, onChange, readOnly, disabled, ...props }) => createElement('input', { ...props, 'aria-label': props['aria-label'] || label, readOnly, disabled, value, onChange: event => onChange(event.target.value) });
export const TextField = ({ label, value, onChange, disabled, ...props }) => createElement('textarea', { ...props, 'aria-label': props['aria-label'] || label, disabled, value, onChange: event => onChange(event.target.value) });
export const SelectField = ({ label, value, onChange, options, compact, disabled, ...props }) => createElement('select', { ...props, 'aria-label': label, disabled, value, onChange: event => onChange(event.target.value) }, options.map(option => { const item = typeof option === 'string' ? { value: option, label: option } : option; return createElement('option', { key: item.value, value: item.value }, item.label); }));
`;

export const checkboxStub = `
export const Checkbox = ({ children, isSelected, onValueChange, isDisabled, size, ...props }) => createElement('label', { className: props.className, title: props.title }, createElement('input', { type: 'checkbox', 'aria-label': props['aria-label'], checked: isSelected, disabled: isDisabled, onChange: event => onValueChange(event.target.checked) }), children);
`;
