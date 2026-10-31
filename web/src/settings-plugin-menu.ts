import { settingsCategories } from './settings-navigation';

type Menu = { id: string; title: string; category?: string; page?: boolean; children?: { id: string; title: string }[] };

export function pluginSettingsCategory(menu: Menu) {
  return settingsCategories.find(category => category.name === menu.category)?.name;
}

export function settingsWithPluginMenus(menus: Menu[]) {
  return settingsCategories.map(category => ({
    ...category,
    sections: [...category.sections, ...menus.filter(menu => pluginSettingsCategory(menu) === category.name).flatMap(menu => {
      const children = menu.children || [];
      return children.length ? children.map(child => ({
        name: `plugin:${menu.id}:${child.id}`, label: child.title, keywords: `${menu.title} ${child.title}`,
      })) : [{ name: `plugin:${menu.id}`, label: menu.title, keywords: menu.title }];
    })],
  }));
}
