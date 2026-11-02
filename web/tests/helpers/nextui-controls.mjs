// Keep tests at NextUI's public callback boundary; browser QA covers its DOM,
// keyboard handling, focus management and motion.
export const nextUIControlStubs = `
export const Button = ({children, onPress, isDisabled, isLoading, startContent, endContent, isIconOnly, variant, size, color, ...props}) => createElement('button', {...props, type:props.type || 'button', disabled:!!isDisabled || !!isLoading, onClick:onPress}, startContent, children, endContent);
export const Input = ({label, value, onValueChange, startContent, classNames, isRequired, isDisabled, validationBehavior, labelPlacement, variant, size, ...props}) => createElement('label', {className:classNames?.base}, label, startContent, createElement('input', {...props, value, required:isRequired, disabled:isDisabled, onChange:event=>onValueChange(event.target.value)}));
export const Tab = () => null;
export const Tabs = ({children, selectedKey, onSelectionChange, classNames, 'aria-label':label}) => createElement('div', {className:classNames?.base, role:'tablist', 'aria-label':label}, (Array.isArray(children) ? children : [children]).filter(Boolean).map(tab=>createElement('button', {key:tab.key, type:'button', role:'tab', 'aria-selected':String(tab.key)===String(selectedKey), onClick:()=>onSelectionChange(tab.key)}, tab.props.title)));
export const Card = ({children, as='article', className}) => createElement(as, {className}, children);
export const CardHeader = ({children, className}) => createElement('header', {className}, children);
export const CardBody = ({children, className}) => createElement('div', {className}, children);
export const CardFooter = ({children, className}) => createElement('footer', {className}, children);
export const Switch = ({isSelected, onValueChange, isDisabled, className, 'aria-label':label}) => createElement('input', {type:'checkbox', role:'switch', className, 'aria-label':label, 'aria-checked':isSelected, checked:isSelected, disabled:isDisabled, onChange:event=>onValueChange(event.target.checked)});
export const Progress = ({'aria-label':label}) => createElement('div', {role:'progressbar', 'aria-label':label});
`;
