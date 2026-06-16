class AddMcpOauthFields < ActiveRecord::Migration[8.1]
  def change
    change_column_null :oauth_apps, :client_id, true
    add_column :broker_credentials, :resource, :string
  end
end
