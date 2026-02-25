import mongoose from 'mongoose';

mongoose.connect('mongodb+srv://ibretlikvelet_db_user:na6MhjOuUpLpYoau@cluster0.xcw1vgy.mongodb.net/?retryWrites=true&w=majority&appName=Cluster0')
    .then(() => {
        console.log('✅ Bağlantı BAŞARILI!');
        process.exit(0);
    })
    .catch(err => {
        console.error('❌ Bağlantı HATALI:', err);
        process.exit(1);
    });
